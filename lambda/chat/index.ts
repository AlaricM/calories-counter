/**
 * Chat orchestrator — the backend for the web app. This is a Lambda RESPONSE_STREAM
 * handler on a Function URL: the browser POSTs the conversation, we authenticate
 * the user's API key, then run a deterministic pipeline and stream the reply back
 * as Server-Sent Events.
 *
 * The pipeline is intentionally NOT one autonomous agent. Each step is small:
 *   1. parseIntent()   — one LLM call: classify the message + extract fields.
 *   2. runWorkflow()   — plain TypeScript: sequences DB/search calls, runs the
 *                        deterministic macro validator, and (only when needed) a
 *                        narrow sanity LLM. Emits tool-chip events. Returns a
 *                        structured result. Never does math itself.
 *   3. narrateResult() — one LLM call: phrase the already-computed result, streamed.
 *
 * Stateless: the browser holds the message history and sends it each turn; durable
 * state (foods, daily log) lives in DynamoDB. A pending confirmation lives in the
 * conversation history, so `confirm` works across turns with no server state.
 */
import { resolveUser } from "../shared/users";
import { parseIntent } from "../shared/intent";
import { runWorkflow } from "../shared/workflows";
import { narrateResult } from "../shared/responder";
import type { ChatMessage } from "../shared/openai";

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

// Cap retained client turns so a runaway history can't blow up token cost.
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

      // 1. Understand intent (one narrow LLM call).
      const intent = await parseIntent(history);

      // 2. Run the matching deterministic workflow. It emits tool-chip events for
      //    each real data operation and returns a fully-computed result.
      const result = await runWorkflow(userId, intent, (name, phase) =>
        send({ type: "tool", name, phase })
      );

      // 3. Narrate the result (one narrow LLM call), streamed to the browser.
      for await (const delta of narrateResult(history, result)) {
        if (delta) send({ type: "delta", text: delta });
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
