/**
 * The tool registry — the single source of truth for every tool the chat
 * orchestrator can call. Each entry pairs a Zod input schema with a handler that
 * runs against DynamoDB (or the web-search lookup). The orchestrator turns these
 * into OpenAI "function" tools with toOpenAITools() and executes them by name
 * with dispatch(); there is no separate MCP transport anymore.
 *
 * Every handler takes `userId` first and is structurally scoped to that user's
 * DynamoDB partition (see db.ts), so one user can never touch another's data.
 */

import { z } from "zod";
import {
  addAlias,
  addFoodItem,
  addFoodToDailyCount,
  deleteDailyEntry,
  deleteFoodItem,
  findFoodItem,
  findFoodItemFuzzy,
  listDailyEntries,
} from "./db";
import { searchNutritionFacts } from "./nutrition-search";
import type { OpenAITool } from "./openai";
import type {
  AddAliasInput,
  AddFoodItemInput,
  AddFoodToDailyCountInput,
  DeleteDailyEntryInput,
  DeleteFoodItemInput,
  FindFoodItemInput,
} from "../../types";

// Serving as a precise weight (oz) or volume (floz), never freeform text — so an
// amount the user reports later can be reconciled against it deterministically
// (see units.ts). Optional: some foods are counted in discrete pieces.
const servingSchema = z
  .object({
    quantity: z.number().positive().describe("Numeric size of one serving, e.g. 8"),
    unit: z
      .enum(["oz", "floz"])
      .describe("'oz' for weight (solids) or 'floz' for volume (liquids)"),
  })
  .optional()
  .describe(
    "Serving size as a precise weight or volume — NOT freeform text. Convert common " +
      "measures yourself, e.g. '1/4 cup' -> { quantity: 2, unit: 'floz' }, '3.5oz' -> " +
      "{ quantity: 3.5, unit: 'oz' }, '100g' -> grams to oz (1oz = 28.35g). Provide it for " +
      "any food with a real weight or volume; only omit it for discrete pieces (e.g. 'egg')."
  );

export type ToolDef = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (userId: string, args: any) => Promise<string>;
};

export const TOOLS: ToolDef[] = [
  {
    name: "find_food_item",
    description:
      "Look up a previously saved food item's nutrition info by name or alias. " +
      "Supports exact and partial matches. Returns each item's serving as { quantity, unit } " +
      "in oz or floz when saved. If nothing matches exactly, returns fuzzy suggestions ranked " +
      "by similarity — confirm with the user before treating a fuzzy suggestion as the item they meant. " +
      "ALWAYS call this before asking the user for a food's nutrition or searching the web.",
    schema: { query: z.string().describe("Food name to search for, e.g. 'cheese sticks'") },
    handler: async (userId, { query }: FindFoodItemInput) => {
      const results = await findFoodItem(userId, query);
      if (results.length > 0) return JSON.stringify(results, null, 2);

      const fuzzy = await findFoodItemFuzzy(userId, query);
      if (fuzzy.length === 0) return `No food item found matching "${query}".`;
      return (
        `No exact match for "${query}". Closest saved items (not confirmed — check with the user before logging):\n` +
        JSON.stringify(
          fuzzy.map(({ item, similarityPercent }) => ({ ...item, similarityPercent })),
          null,
          2
        )
      );
    },
  },
  {
    name: "search_nutrition_facts",
    description:
      "Search the internet for nutrition facts for a common food (e.g. 'ribeye', 'oatmeal', " +
      "'greek yogurt') and return calories + macros per serving with the serving as oz (weight) " +
      "or floz (volume). USE THIS when find_food_item finds nothing OR when the user gives " +
      "incomplete data (e.g. calories but no macros). It only RETURNS facts — after it returns, " +
      "call add_food_item to save them (adjust to the user's own numbers first if they gave any).",
    schema: {
      query: z
        .string()
        .describe("The food to look up, e.g. 'ribeye steak' or 'quaker oats dry'."),
    },
    handler: async (_userId, { query }: { query: string }) => {
      const facts = await searchNutritionFacts(query);
      return JSON.stringify(facts, null, 2);
    },
  },
  {
    name: "add_food_item",
    description:
      "Upsert a food item with its nutrition info in the personal food database. Use this to " +
      "add, update, or define a food, e.g. 'add cheese sticks, 50 cal, 6g protein, 2.5g fat', or " +
      "to persist facts returned by search_nutrition_facts. IMPORTANT: convert the serving size to " +
      "`serving: { quantity, unit }` in oz (weight) or floz (volume) yourself — do not pass freeform text.",
    schema: {
      item: z.string().describe("Name of the food item, e.g. 'cheese sticks'"),
      aliases: z
        .array(z.string())
        .optional()
        .describe("Alternative names, e.g. ['160 cal greek yogurt']"),
      calories: z.number().describe("Calories per serving"),
      proteinG: z.number().optional().describe("Protein per serving, in grams"),
      fatG: z.number().optional().describe("Fat per serving, in grams"),
      carbsG: z.number().optional().describe("Carbohydrates per serving, in grams"),
      serving: servingSchema,
    },
    handler: async (userId, args: AddFoodItemInput) => {
      const record = await addFoodItem(userId, args);
      return `Saved: ${JSON.stringify(record)}`;
    },
  },
  {
    name: "add_alias",
    description:
      "Add an alternative name (alias) to an existing food item, e.g. 'also call Greek yogurt " +
      "160 cal greek yogurt'.",
    schema: {
      food: z.string().describe("Canonical name of the existing food, e.g. 'Greek yogurt'"),
      alias: z.string().describe("Alternative name to add, e.g. '160 cal greek yogurt'"),
    },
    handler: async (userId, { food, alias }: AddAliasInput) => {
      const record = await addAlias(userId, food, alias);
      return `Updated: ${JSON.stringify(record)}`;
    },
  },
  {
    name: "add_food_to_daily_count",
    description:
      "Log a known food into today's running daily totals, e.g. 'I ate an apple today'. Appends " +
      "the item to today's tracker and updates cumulative calories and macros. IMPORTANT: whenever " +
      "the user states an amount, convert it to oz (weight) or floz (volume) and pass it as " +
      "`amountEaten` (e.g. '6oz', '1.5floz'); do NOT compute a `quantity` yourself — the server " +
      "divides amountEaten by the food's saved serving size. Only pass a plain `quantity` (servings " +
      "count) when the user gives a count with no amount, e.g. 'two servings'.",
    schema: {
      query: z.string().describe("Food name or alias to find in the saved food database."),
      amountEaten: z
        .string()
        .optional()
        .describe(
          "Amount actually eaten, converted to oz (weight) or floz (volume), e.g. '6oz'. " +
            "Preferred over quantity: the server divides it by the saved serving size."
        ),
      quantity: z
        .number()
        .optional()
        .describe("Number of servings, only when no amount was stated (defaults to 1)."),
      serving: servingSchema,
    },
    handler: async (userId, args: AddFoodToDailyCountInput) => {
      const record = await addFoodToDailyCount(
        userId,
        args.query,
        args.quantity,
        args.serving,
        args.amountEaten
      );
      return (
        `Logged for ${record.day}: ${record.order}. ${record.item} (${record.calories} cal, ` +
        `${record.carbsG}g carbs, ${record.fatG}g fat, ${record.proteinG}g protein). ` +
        `Total so far: ${record.cumulativeCalories} cal, ${record.cumulativeCarbsG}g carbs, ` +
        `${record.cumulativeFatG}g fat, ${record.cumulativeProteinG}g protein.`
      );
    },
  },
  {
    name: "list_daily_entries",
    description:
      "List today's daily tracked food entries, including order and cumulative totals. Use this " +
      "when the user wants to know what they've eaten today so far or 'how am I doing'.",
    schema: {
      day: z
        .string()
        .optional()
        .describe("Optional date in yyyy-mm-dd format. Defaults to today in Central Time."),
    },
    handler: async (userId, { day }: { day?: string }) => {
      const entries = await listDailyEntries(userId, day);
      if (entries.length === 0) {
        return day ? `No entries found for ${day}.` : "No entries found for today.";
      }
      return JSON.stringify(entries, null, 2);
    },
  },
  {
    name: "delete_daily_entry",
    description:
      "Delete a single entry from today's daily tracker without removing the food from the saved " +
      "database. Use this to correct an eaten item logged by mistake.",
    schema: {
      day: z
        .string()
        .optional()
        .describe("Optional date in yyyy-mm-dd format. Defaults to today in Central Time."),
      order: z.number().describe("The entry order number to remove from the day's tracker."),
    },
    handler: async (userId, { day, order }: DeleteDailyEntryInput) => {
      const record = await deleteDailyEntry(userId, day, order);
      return `Deleted daily entry ${order} for ${record.day}: ${record.item} (${record.calories} cal).`;
    },
  },
  {
    name: "delete_food_item",
    description:
      "Delete an existing food item by canonical name, e.g. 'delete cheese sticks'.",
    schema: { item: z.string().describe("Name of the food item to delete, e.g. 'cheese sticks'") },
    handler: async (userId, { item }: DeleteFoodItemInput) => {
      await deleteFoodItem(userId, item);
      return `Deleted food item: ${item}`;
    },
  },
];

/** OpenAI "function" tool definitions derived from the registry's Zod schemas. */
export function toOpenAITools(): OpenAITool[] {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(z.object(t.schema)) as Record<string, unknown>,
    },
  }));
}

/**
 * Run a tool by name for a user. Validates the model-supplied JSON arguments
 * against the tool's schema and returns a text result (or a readable error
 * string, which the model can react to) — it never throws.
 */
export async function dispatch(userId: string, name: string, argsJson: string): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Unknown tool: ${name}`;

  let raw: unknown;
  try {
    raw = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return `Invalid JSON arguments for ${name}.`;
  }

  try {
    const args = z.object(tool.schema).parse(raw);
    return await tool.handler(userId, args);
  } catch (err) {
    return err instanceof Error ? err.message : `Failed to run ${name}.`;
  }
}
