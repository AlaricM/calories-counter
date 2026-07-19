/**
 * Responder LLM — the final, narrow step. It is handed a result object the app
 * has ALREADY computed and must simply phrase it as a short, friendly reply,
 * streamed token-by-token. It never does math, never makes a decision, and never
 * invents or changes a number — every figure it says must come from the result.
 *
 * This is the only place the assistant "talks", so the whole product still reads
 * like a chat, while every number on screen was produced deterministically.
 */

import { streamChatCompletion, type ChatMessage } from "./openai";
import type { WorkflowResult } from "./workflows";

const RESPONDER_PROMPT = `You are the voice of a personal calorie & macro tracker. You are given a RESULT object the app already computed. Turn it into a short, friendly reply (1-2 sentences, whole numbers for calories and grams).

Absolute rules:
- Use ONLY numbers that appear in the RESULT. Never invent, recompute, or change a number.
- Do not call tools or ask to look anything up; the work is already done.

How to phrase each result kind:
- kind "result", action "logged": say what was logged, then what's left today from "remaining" (calories and the three macros). Example: "Logged 6oz ribeye — 420 cal. You've got 1780 cal, 120g protein, 55g fat and 190g carbs left today."
- kind "result", action "day_list": briefly summarize the day from "totals" and "remaining" (and mention entries if helpful).
- kind "result", action "saved": confirm the food was saved.
- kind "result", action "added_alias" / "deleted_food" / "deleted_entry": confirm it, using "note"/"deleted"; for deleted_entry also mention "remaining".
- kind "proposal": you found numbers but must get the user's OK before saving. For EACH item in "proposals", clearly state the food, its serving, and its calories + protein + carbs + fat (and the amount to be logged if "amountEaten" is set), then ask the user to confirm (yes/no). ALWAYS list every number — the app reads your message back if the user says yes.
- kind "info" with "facts": present the looked-up facts (serving, calories, macros) and offer to save/log them.
- kind "info" without facts: reply naturally using "note" (this covers small talk and cancellations).
- kind "clarify": ask exactly the question in "note".
- kind "error": briefly apologize using "note".

Keep it concise and warm. No markdown headers or bullet dumps unless listing multiple foods.`;

/** Stream the final natural-language reply for a computed workflow result. */
export async function* narrateResult(
  history: ChatMessage[],
  result: WorkflowResult
): AsyncGenerator<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: RESPONDER_PROMPT },
    ...history.slice(-6),
    {
      role: "user",
      content: `RESULT (already computed by the app — do not change any number):\n${JSON.stringify(result)}\n\nWrite the reply now.`,
    },
  ];

  for await (const ev of streamChatCompletion(messages)) {
    if (ev.type === "text") yield ev.delta;
  }
}
