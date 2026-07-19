/**
 * Browser-side client for the streaming chat backend. Mirrors the SSE events the
 * chat Lambda emits (see lambda/chat/index.ts): text deltas, tool activity, and
 * a terminal done/error.
 */

export type ChatRole = "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type ServerEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; phase: "start" | "end" }
  | { type: "error"; message: string }
  | { type: "done" };

/** Where the frontend finds its config: /config.json is written by CDK at deploy. */
export type AppConfig = { chatUrl?: string };

export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return {};
    return (await res.json()) as AppConfig;
  } catch {
    return {};
  }
}

export class AuthError extends Error {}

/**
 * POST the conversation and yield parsed server events as they stream in. Throws
 * AuthError on 401/403 so the UI can prompt for a valid key.
 */
export async function* streamChat(
  chatUrl: string,
  apiKey: string,
  messages: ChatMessage[]
): AsyncGenerator<ServerEvent> {
  const res = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ messages }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthError("Your API key was rejected. Check it and try again.");
  }
  if (!res.ok || !res.body) {
    throw new Error(`Server error (${res.status}). Please try again.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    // SSE frames are separated by a blank line.
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data) continue;
      try {
        yield JSON.parse(data) as ServerEvent;
      } catch {
        // ignore malformed frame
      }
    }
  }
}

/** Human-friendly label for a tool the assistant is running. */
export function toolLabel(name: string): string {
  switch (name) {
    case "find_food_item":
      return "Checking your saved foods";
    case "search_nutrition_facts":
      return "Searching nutrition facts online";
    case "add_food_item":
      return "Saving food";
    case "add_alias":
      return "Adding an alias";
    case "add_food_to_daily_count":
      return "Logging to today";
    case "list_daily_entries":
      return "Reading today's log";
    case "delete_daily_entry":
      return "Removing an entry";
    case "delete_food_item":
      return "Deleting a food";
    default:
      return name;
  }
}
