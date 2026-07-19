/**
 * Minimal OpenAI client over `fetch` (no SDK — keeps the Lambda bundle tiny and
 * arm64-safe, since there are no compiled deps). Two capabilities are used:
 *
 *   1. streamChatCompletion() — the agentic loop for the web app. Streams token
 *      deltas as they arrive and assembles any tool calls the model requests, so
 *      the chat orchestrator (lambda/chat) can run tools and continue the loop.
 *   2. responseJsonSchema() — a one-shot Responses API call with the built-in
 *      `web_search` tool + a strict JSON schema, used by nutrition-search.ts to
 *      pull real nutrition facts off the web in exactly our storage shape.
 *
 * The API key comes from the OPENAI_API_KEY Lambda env var (set from .env at
 * deploy time). Model ids are env-overridable so you can trade cost for quality
 * without a code change.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-nano";
export const SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL ?? "gpt-5-nano";

const BASE_URL = "https://api.openai.com/v1";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant turns that request tools. */
  tool_calls?: ToolCall[];
  /** Present on tool-result turns; links back to the assistant's tool_call id. */
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** An OpenAI "function" tool definition (parameters is a JSON Schema object). */
export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "done"; message: ChatMessage; finishReason: string | null };

function authHeaders(): Record<string, string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  return {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Streams a Chat Completions call. Yields `{ type: "text" }` for each content
 * delta as it arrives, then a single `{ type: "done" }` carrying the fully
 * assembled assistant message (content + any tool_calls) so the caller can
 * decide whether to run tools and loop again.
 */
export async function* streamChatCompletion(
  messages: ChatMessage[],
  tools: OpenAITool[]
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI chat error ${res.status}: ${detail.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  const toolCalls: ToolCall[] = [];

  const flushLine = function* (line: string): Generator<StreamEvent> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]" || data === "") return;

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // ignore keep-alive / partial lines
    }
    const choice = json.choices?.[0];
    if (!choice) return;

    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i: number = tc.index ?? 0;
        const slot = (toolCalls[i] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text", delta: delta.content };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield* flushLine(line);
    }
  }
  if (buffer.length > 0) yield* flushLine(buffer);

  const message: ChatMessage = {
    role: "assistant",
    content: content.length > 0 ? content : null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.filter((tc) => tc.function.name);
  }
  yield { type: "done", message, finishReason };
}

/**
 * One-shot Responses API call that returns a value matching `schema`. When
 * `webSearch` is true the model may browse the web first (built-in web_search
 * tool). Uses strict JSON-schema structured output so the returned text always
 * parses into the expected shape.
 */
export async function responseJsonSchema<T>(opts: {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  webSearch?: boolean;
}): Promise<T> {
  const body: Record<string, unknown> = {
    model: opts.model,
    instructions: opts.instructions,
    input: opts.input,
    text: {
      format: {
        type: "json_schema",
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  };
  if (opts.webSearch) body.tools = [{ type: "web_search" }];

  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI responses error ${res.status}: ${detail.slice(0, 500)}`);
  }

  const json: any = await res.json();
  const text = extractOutputText(json);
  if (!text) throw new Error("OpenAI responses returned no text output.");
  return JSON.parse(text) as T;
}

/** Pull the assistant's output_text out of a Responses API payload. */
function extractOutputText(json: any): string {
  if (typeof json.output_text === "string" && json.output_text.length > 0) {
    return json.output_text;
  }
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}
