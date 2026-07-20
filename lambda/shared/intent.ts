/**
 * Orchestrator LLM — the ONLY job of this call is to understand what the user
 * wants and extract the fields for it. It classifies the latest message into
 * exactly one intent and pulls out structured parameters. It never does math,
 * never invents a nutrition number, and never touches the database — those are
 * the deterministic workflow's job. Strict JSON-schema output keeps the shape
 * guaranteed.
 */

import { responseJsonSchema, CHAT_MODEL, type ChatMessage } from "./openai";
import type { JsonSchemaObject } from "./json-schema";
import type { ServingUnit } from "../../types";

/** A single food the user mentioned (to log, to save, or to confirm). */
export type FoodSpec = {
  name: string;
  /** Amount eaten, restated in oz (weight) or floz (volume), e.g. "6oz". */
  amountEaten: string | null;
  /** A plain count of servings, when no measured amount was given. */
  quantity: number | null;
  /** Nutrition numbers — filled ONLY when explicitly stated (by the user, or by
   * the assistant's prior proposal on a confirmation). Never computed here. */
  calories: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  servingQuantity: number | null;
  servingUnit: ServingUnit | null;
};

export type IntentName =
  | "log_food"
  | "add_or_update_food"
  | "add_alias"
  | "delete_food"
  | "delete_entry"
  | "list_day"
  | "search_nutrition"
  | "validate_entry"
  | "confirm"
  | "cancel"
  | "smalltalk";

export type Intent = {
  intent: IntentName;
  items: FoodSpec[] | null;
  food: string | null;
  alias: string | null;
  day: string | null;
  order: number | null;
  message: string | null;
};

// OpenAI strict structured output requires every property to be listed in
// `required` and additionalProperties:false; optionality is expressed by
// allowing null in the type.
const FOOD_SPEC_SCHEMA: JsonSchemaObject<FoodSpec> = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Food name as the user said it." },
    amountEaten: {
      type: ["string", "null"],
      description: "Amount eaten restated in oz (weight) or floz (volume), e.g. '6oz', '1.5floz'. Convert grams at 1oz=28.35g and cups at 1cup=8floz. Null if only a serving count was given.",
    },
    quantity: {
      type: ["number", "null"],
      description: "Plain number of servings, only when no measured amount was given (e.g. 'two servings' -> 2). Null otherwise.",
    },
    calories: { type: ["number", "null"], description: "Per-serving calories ONLY if explicitly stated. Never computed." },
    proteinG: { type: ["number", "null"], description: "Per-serving protein grams ONLY if explicitly stated." },
    fatG: { type: ["number", "null"], description: "Per-serving fat grams ONLY if explicitly stated." },
    carbsG: { type: ["number", "null"], description: "Per-serving carb grams ONLY if explicitly stated." },
    servingQuantity: { type: ["number", "null"], description: "Serving size number if stated, e.g. 4 for '4oz'." },
    servingUnit: { type: ["string", "null"], enum: ["oz", "floz", null], description: "'oz' or 'floz' if a serving size was stated." },
  },
  required: [
    "name",
    "amountEaten",
    "quantity",
    "calories",
    "proteinG",
    "fatG",
    "carbsG",
    "servingQuantity",
    "servingUnit",
  ],
};

const INTENT_SCHEMA: JsonSchemaObject<Intent> = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: [
        "log_food",
        "add_or_update_food",
        "add_alias",
        "delete_food",
        "delete_entry",
        "list_day",
        "search_nutrition",
        "validate_entry",
        "confirm",
        "cancel",
        "smalltalk",
      ],
      description: "The single best-matching intent for the latest user message.",
    },
    items: {
      type: ["array", "null"],
      description: "Foods for log_food, add_or_update_food, or confirm. Null for other intents.",
      items: FOOD_SPEC_SCHEMA,
    },
    food: { type: ["string", "null"], description: "Single food name for delete_food / validate_entry / search_nutrition / add_alias target." },
    alias: { type: ["string", "null"], description: "New alternate name for add_alias." },
    day: { type: ["string", "null"], description: "A specific day as yyyy-mm-dd, if the user named one. Null means today." },
    order: { type: ["number", "null"], description: "Daily-log entry number for delete_entry." },
    message: { type: ["string", "null"], description: "For smalltalk: a short hint of what to say back. Otherwise null." },
  },
  required: ["intent", "items", "food", "alias", "day", "order", "message"],
};

const INSTRUCTIONS = `You are the intent parser for a personal calorie & macro tracker. Read the conversation and classify ONLY the latest user message into exactly one intent, extracting its fields into the JSON schema.

Hard rules:
- NEVER compute or invent a nutrition number. Fill calories/proteinG/fatG/carbsG and servingQuantity/servingUnit ONLY when they were explicitly stated by the user (or, on a confirmation, by the assistant's immediately preceding proposal). Copy them verbatim. Otherwise use null.
- Do not do arithmetic on macros. The only conversion you may do is restating an eaten amount or serving size in oz (weight) or floz (volume).

Intent guide:
- log_food: the user says they ate something -> items[] with each food's name and amountEaten (or quantity). Include stated numbers only.
- add_or_update_food: the user explicitly wants to save/change a food's nutrition -> items[] with the stated numbers.
- add_alias: the user wants another name for a saved food -> food (the saved one) + alias (the new name).
- delete_food: remove a saved food -> food.
- delete_entry: remove a logged entry from today -> order (the entry number), optional day.
- list_day: "what did I eat", "how am I doing" -> optional day.
- search_nutrition: "how many calories in X" with no logging/saving -> food.
- validate_entry: re-check a saved food's numbers -> food.
- confirm: the assistant's previous message proposed saving/logging a food and the user affirms ("yes", "yep", "do it", "log it"). Set intent=confirm and copy the proposed food(s) — name, calories, macros, serving, and the eaten amount — from that proposal into items[].
- cancel: the user declines a pending proposal ("no", "never mind", "cancel").
- smalltalk: anything conversational with no food action -> put a brief reply hint in message.

Pick the single most appropriate intent. Return only the JSON object.`;

/** Serialize the last few turns for the parser (it mainly needs recent context). */
function renderConversation(history: ChatMessage[]): string {
  return history
    .slice(-10)
    .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
    .join("\n");
}

export async function parseIntent(history: ChatMessage[]): Promise<Intent> {
  return responseJsonSchema<Intent>({
    model: CHAT_MODEL,
    instructions: INSTRUCTIONS,
    input: renderConversation(history),
    schemaName: "user_intent",
    schema: INTENT_SCHEMA,
  });
}
