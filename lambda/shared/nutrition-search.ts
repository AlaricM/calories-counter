/**
 * Internet nutrition lookup. When a food isn't in the user's database (or the
 * user gave incomplete numbers), the model calls this to fetch real nutrition
 * facts for a common food — "ribeye", "oatmeal", "greek yogurt" — off the web
 * and convert them into OUR storage shape: calories + macros per serving, with
 * the serving as a precise weight (oz) or volume (floz), never freeform text.
 *
 * Powered by OpenAI's Responses API with the built-in web_search tool and a
 * strict JSON-schema output, so the result drops straight into add_food_item.
 */

import { responseJsonSchema, SEARCH_MODEL } from "./openai";
import type { ServingSize } from "../../types";

export type NutritionFacts = {
  item: string;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  serving: ServingSize;
  /** One line on where the numbers came from / assumptions made. */
  sourceNote: string;
};

const NUTRITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    item: { type: "string", description: "Canonical food name, e.g. 'Ribeye steak'." },
    calories: { type: "number", description: "Calories per serving." },
    proteinG: { type: "number", description: "Protein grams per serving." },
    fatG: { type: "number", description: "Fat grams per serving." },
    carbsG: { type: "number", description: "Carbohydrate grams per serving." },
    serving: {
      type: "object",
      additionalProperties: false,
      properties: {
        quantity: { type: "number", description: "Serving size number, e.g. 4." },
        unit: {
          type: "string",
          enum: ["oz", "floz"],
          description: "'oz' for weight (solids), 'floz' for volume (liquids).",
        },
      },
      required: ["quantity", "unit"],
    },
    sourceNote: {
      type: "string",
      description: "One short line on the source and any assumptions.",
    },
  },
  required: ["item", "calories", "proteinG", "fatG", "carbsG", "serving", "sourceNote"],
};

const INSTRUCTIONS = `You are a nutrition-facts researcher for a calorie and macro tracker.
Given a food, search the web for reliable nutrition information (USDA FoodData Central, manufacturer labels, or reputable databases) and report values PER SERVING.

Rules:
- Express the serving as a precise weight in ounces ('oz') or volume in fluid ounces ('floz') — convert grams (1 oz = 28.35 g) or cups (1 cup = 8 floz) yourself. Use 'oz' for solids, 'floz' for liquids.
- Prefer a natural, common serving (e.g. 4 oz raw for a steak, 1 oz dry for oatmeal). State it in sourceNote.
- Calories must reconcile with macros: calories ≈ 4×protein + 4×carbs + 9×fat. Adjust to a consistent set of numbers rather than reporting values that don't add up.
- Round macros to whole or one-decimal grams. Return numbers only.`;

/** Look up nutrition facts for a common food and return them per oz/floz serving. */
export async function searchNutritionFacts(query: string): Promise<NutritionFacts> {
  return responseJsonSchema<NutritionFacts>({
    model: SEARCH_MODEL,
    instructions: INSTRUCTIONS,
    input: `Find per-serving nutrition facts for: ${query}`,
    schemaName: "nutrition_facts",
    schema: NUTRITION_SCHEMA,
    webSearch: true,
  });
}
