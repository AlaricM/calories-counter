/**
 * Chat orchestrator — the backend for the web app. This is a Lambda RESPONSE_STREAM
 * handler on a Function URL: the browser POSTs the conversation, we authenticate
 * the user's API key, run the agentic loop against OpenAI (gpt-5-nano) with our
 * tools, and stream the assistant's tokens + tool activity back as Server-Sent
 * Events so the reply renders "on the fly".
 *
 * Stateless like the old MCP server: the browser holds the message history and
 * sends it each turn; the durable state (foods, daily log) lives in DynamoDB.
 */
import { resolveUser } from "../shared/users";
import { SYSTEM_PROMPT } from "../shared/system-prompt";
import { streamChatCompletion, type ChatMessage } from "../shared/openai";
import { dispatch, toOpenAITools } from "../shared/tools";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SSE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

// Safety rails on the loop so a misbehaving model can't spin forever / rack cost.
const MAX_TURNS = 8;
const MAX_HISTORY = 40;

type ClientEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; phase: "start" | "end" }
  | { type: "error"; message: string }
  | { type: "done" };

function getHeader(event: any, name: string): string | undefined {
  const headers = event.headers ?? {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

/** Bearer token from the Authorization header. */
function extractApiKey(event: any): string | undefined {
  const auth = getHeader(event, "authorization");
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return undefined;
}

function parseBody(event: any): any {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Keep only well-formed user/assistant turns from the client, capped in length. */
function sanitizeHistory(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const clean: ChatMessage[] = [];
  for (const m of messages) {
    const role = (m as any)?.role;
    const content = (m as any)?.content;
    if ((role === "user" || role === "assistant") && typeof content === "string") {
      clean.push({ role, content });
    }
  }
  return clean.slice(-MAX_HISTORY);
}

/** Open the HTTP response with a status + headers and write a JSON error body. */
function writeError(
  responseStream: awslambda.ResponseStream,
  statusCode: number,
  message: string
): void {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
  stream.write(JSON.stringify({ error: message }));
  stream.end();
}

export const handler = awslambda.streamifyResponse(
  async (event: any, responseStream: awslambda.ResponseStream): Promise<void> => {
    const method: string = event?.requestContext?.http?.method ?? "POST";
    if (method === "OPTIONS") {
      // Function URL CORS normally answers preflight without invoking us; this is
      // a belt-and-suspenders fallback.
      const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 204,
        headers: CORS_HEADERS,
      });
      stream.end();
      return;
    }

    // --- Auth (before we commit to a 200 stream) ---
    let userId: string;
    try {
      const key = extractApiKey(event);
      if (!key) return writeError(responseStream, 401, "unauthorized");
      const user = await resolveUser(key);
      if (!user) return writeError(responseStream, 403, "forbidden");
      userId = user.userId;
    } catch (err) {
      console.error("auth error", err);
      return writeError(responseStream, 500, "auth failure");
    }

    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: SSE_HEADERS,
    });
    const send = (evt: ClientEvent) => stream.write(`data: ${JSON.stringify(evt)}\n\n`);

    try {
      const body = parseBody(event);
      const history = sanitizeHistory(body.messages);
      if (history.length === 0) {
        send({ type: "error", message: "No messages provided." });
        send({ type: "done" });
        stream.end();
        return;
      }

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
      ];
      const tools = toOpenAITools();

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        let assistant: ChatMessage | undefined;
        for await (const ev of streamChatCompletion(messages, tools)) {
          if (ev.type === "text") send({ type: "delta", text: ev.delta });
          else if (ev.type === "done") assistant = ev.message;
        }
        if (!assistant) break;
        messages.push(assistant);

        const toolCalls = assistant.tool_calls ?? [];
        if (toolCalls.length === 0) break;

        for (const tc of toolCalls) {
          send({ type: "tool", name: tc.function.name, phase: "start" });
          const result = await dispatch(userId, tc.function.name, tc.function.arguments);
          send({ type: "tool", name: tc.function.name, phase: "end" });
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
      }

      send({ type: "done" });
    } catch (err) {
      console.error("chat error", err);
      send({ type: "error", message: "Something went wrong. Please try again." });
      send({ type: "done" });
    } finally {
      stream.end();
    }
  }
);
