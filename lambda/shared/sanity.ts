/**
 * Sanity LLM — a single, narrow common-sense check. Given a food name and its
 * per-serving numbers, it judges whether they are *believable for that food*
 * using world knowledge, and decides whether an external lookup is warranted.
 *
 * It does NOT do arithmetic (the deterministic layer in ./nutrition already did),
 * does NOT touch the database, and does NOT call other tools. Its only output is
 * a verdict the workflow acts on. It runs only when the deterministic check flags
 * a problem, or as a last gate before storing web-searched / estimated numbers.
 */

import { responseJsonSchema, CHAT_MODEL } from "./openai";
import type { MacroField } from "./nutrition";

export type SanityVerdict = {
  status: "valid" | "suspect";
  /** The single field that looks most wrong, when status is "suspect". */
  suspected_field: MacroField | null;
  /** accept = use as-is, search = look it up on the web, ask = the name is too vague to judge. */
  action: "accept" | "search" | "ask";
  /** One short line explaining the call. */
  note: string;
};

const SANITY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["valid", "suspect"] },
    suspected_field: {
      type: ["string", "null"],
      enum: ["calories", "proteinG", "fatG", "carbsG", null],
      description: "The single most suspicious field, or null when status is valid.",
    },
    action: { type: "string", enum: ["accept", "search", "ask"] },
    note: { type: "string", description: "One short line explaining the verdict." },
  },
  required: ["status", "suspected_field", "action", "note"],
};

const INSTRUCTIONS = `You are a nutrition plausibility checker for a calorie & macro tracker. You are given a food name and its per-serving numbers. Using common nutrition knowledge, judge whether those numbers are believable FOR THAT FOOD.

Rules:
- Do NOT do arithmetic — a separate deterministic step already checked that calories match the macros. Your job is real-world plausibility (e.g. "chocolate cake with 70 g fat but only 110 calories" is not believable; "olive oil with 0 g protein" is fine).
- If the numbers look realistic, return status="valid", suspected_field=null, action="accept".
- If something looks clearly wrong, return status="suspect", name the single most suspicious field, and set action="search" so the app can look up reliable values.
- Use action="ask" only when the food name is too vague to judge at all.
- Never suggest modifying, storing, or deleting anything. Only judge.

Return only the JSON object.`;

export type SanityInput = {
  name: string;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  /** A short description of what the deterministic layer concluded. */
  deterministicVerdict: string;
};

export async function checkPlausibility(input: SanityInput): Promise<SanityVerdict> {
  const facts =
    `Food: ${input.name}\n` +
    `Per serving: ${input.calories} cal, ${input.proteinG} g protein, ` +
    `${input.carbsG} g carbs, ${input.fatG} g fat\n` +
    `Deterministic math check: ${input.deterministicVerdict}`;
  return responseJsonSchema<SanityVerdict>({
    model: CHAT_MODEL,
    instructions: INSTRUCTIONS,
    input: facts,
    schemaName: "sanity_verdict",
    schema: SANITY_SCHEMA,
  });
}
