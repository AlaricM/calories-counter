import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addAlias, addFoodItem, addFoodToDailyCount, deleteDailyEntry, deleteFoodItem, findFoodItem, findFoodItemFuzzy, listDailyEntries } from "./db";
import { SYSTEM_PROMPT } from "./system-prompt";
import type {
  AddAliasInput,
  AddFoodItemInput,
  AddFoodToDailyCountInput,
  DeleteDailyEntryInput,
  DeleteFoodItemInput,
  FindFoodItemInput,
  ListDailyEntriesInput,
} from "../../types";

// Serving is expressed as a precise weight (oz) or volume (floz) rather than
// freeform text, so it can be reconciled deterministically against whatever
// amount the user later says they ate (see units.ts). Optional — some foods
// (e.g. always counted in discrete pieces) genuinely have no such serving —
// but the description leans hard on the model to convert and provide one
// whenever the food has a meaningful weight/volume, since that's what makes
// add_food_to_daily_count's amountEaten conversion possible later.
const servingSchema = z
  .object({
    quantity: z.number().positive().describe("Numeric size of one serving, e.g. 8"),
    unit: z
      .enum(["oz", "floz"])
      .describe("'oz' for weight (solids) or 'floz' for volume (liquids)"),
  })
  .optional()
  .describe(
    "Serving size as a precise weight or volume — NOT freeform text. Always convert " +
      "common measures yourself before calling this tool, e.g. '1/4 cup' -> { quantity: 2, " +
      "unit: 'floz' } (1 cup = 8 floz), '1 cup' -> { quantity: 8, unit: 'floz' }, '3.5oz' -> " +
      "{ quantity: 3.5, unit: 'oz' }, '100g' -> convert grams to oz (1oz = 28.35g). Strongly " +
      "prefer providing this for any food with a real weight or volume; only omit it for foods " +
      "genuinely counted in discrete pieces with no meaningful weight/volume (e.g. 'egg', 'slice')."
  );

const addFoodItemSchema = {
  item: z.string().describe("Name of the food item, e.g. 'cheese sticks'"),
  aliases: z
    .array(z.string())
    .optional()
    .describe("Alternative names for this food, e.g. ['160 cal greek yogurt']"),
  calories: z.number().describe("Calories per serving"),
  proteinG: z.number().optional().describe("Protein per serving, in grams"),
  fatG: z.number().optional().describe("Fat per serving, in grams"),
  carbsG: z.number().optional().describe("Carbohydrates per serving, in grams"),
  serving: servingSchema,
};

const addAliasSchema = {
  food: z.string().describe("Canonical name of the existing food item, e.g. 'Greek yogurt'"),
  alias: z.string().describe("Alternative name to add, e.g. '160 cal greek yogurt'"),
};

const findFoodItemSchema = {
  query: z.string().describe("Food name to search for, e.g. 'cheese sticks'"),
};

const deleteFoodItemSchema = {
  item: z.string().describe("Name of the food item to delete, e.g. 'cheese sticks'"),
};

/**
 * Builds a fresh MCP server + tool set for a single authenticated user. Called
 * once per request (this Lambda runs stateless — see index.ts). Every tool is
 * bound to `userId`, so a caller can only ever read/write their own foods.
 */
export function buildServer(userId: string): McpServer {
  // `instructions` is surfaced in the MCP initialize result; per the spec a
  // client MAY add it to the model's system prompt, giving every conversation
  // the same counting rules without any per-chat setup.
  const server = new McpServer(
    { name: "food-tracker", version: "0.1.0" },
    { instructions: SYSTEM_PROMPT }
  );

  server.registerTool(
    "add_food_item",
    {
      description:
        "Upsert a food item with its nutrition info in the personal food database. " +
        "Use this when the user wants to add, update, or define a new food, e.g. " +
        "'add cheese sticks, 50 cal, 6g protein, 2.5g fat'. " +
        "IMPORTANT: convert the serving size to `serving: { quantity, unit }` in oz (weight) " +
        "or floz (volume) yourself — do not pass serving as freeform text. Provide it whenever " +
        "the food has a real weight or volume; only skip it for foods counted in discrete pieces.",
      inputSchema: addFoodItemSchema,
    },
    async (args: AddFoodItemInput) => {
      const record = await addFoodItem(userId, args);
      return {
        content: [{ type: "text", text: `Saved: ${JSON.stringify(record)}` }],
      };
    }
  );

  server.registerTool(
    "add_alias",
    {
      description:
        "Add an alternative name (alias) to an existing food item. " +
        "Use this when the user refers to a food by a different name, e.g. " +
        "'also call Greek yogurt 160 cal greek yogurt'.",
      inputSchema: addAliasSchema,
    },
    async ({ food, alias }: AddAliasInput) => {
      try {
        const record = await addAlias(userId, food, alias);
        return {
          content: [{ type: "text", text: `Updated: ${JSON.stringify(record)}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to add alias.";
        return { content: [{ type: "text", text: message }] };
      }
    }
  );

  server.registerTool(
    "find_food_item",
    {
      description:
        "Look up a previously saved food item's nutrition info by name or alias. " +
        "Supports exact and partial matches, e.g. 'I ate one cheese stick'. " +
        "Returns each item's `serving` as a structured { quantity, unit } in oz or floz when saved. " +
        "If nothing matches exactly, falls back to fuzzy suggestions ranked by " +
        "similarity — confirm with the user before treating a fuzzy suggestion as the item they meant.",
      inputSchema: findFoodItemSchema,
    },
    async ({ query }: FindFoodItemInput) => {
      const results = await findFoodItem(userId, query);
      if (results.length > 0) {
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      const fuzzyMatches = await findFoodItemFuzzy(userId, query);
      if (fuzzyMatches.length === 0) {
        return {
          content: [{ type: "text", text: `No food item found matching "${query}".` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `No exact match for "${query}". Closest saved items (not confirmed — check with the user before logging):\n` +
              JSON.stringify(
                fuzzyMatches.map(({ item, similarityPercent }) => ({ ...item, similarityPercent })),
                null,
                2
              ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_daily_entries",
    {
      description:
        "List today's daily tracked food entries, including order and cumulative totals. " +
        "Use this when the user wants to know what they've eaten today so far.",
      inputSchema: {
        day: z
          .string()
          .optional()
          .describe("Optional date in yyyy-mm-dd format. Defaults to today in Central Time."),
      },
    },
    async ({ day }: { day?: string }) => {
      const entries = await listDailyEntries(userId, day);
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: day
                ? `No entries found for ${day}.`
                : "No entries found for today.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(entries, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "add_food_to_daily_count",
    {
      description:
        "Log a known food item into today's running daily totals. Use this when the user says something like 'I ate an apple today' or 'I just ate an apple'. The tool appends the item to today's tracker and updates cumulative calories and macros for the day. " +
        "IMPORTANT: whenever the user states a specific amount, convert it to oz (weight) or floz (volume) and pass it as `amountEaten` (e.g. '6oz', '1.5floz'); do NOT compute a `quantity` yourself — the server divides it by the food's saved serving size for you. Only pass a plain `quantity` (number of servings) when the user gives a serving count with no amount, e.g. 'two servings' or 'I had it twice'.",
      inputSchema: {
        query: z.string().describe("Food name or alias to find in the saved food database."),
        amountEaten: z
          .string()
          .optional()
          .describe(
            "The amount actually eaten, converted to oz (weight) or floz (volume), e.g. '6oz', '1.5floz'. Preferred over quantity: the server divides it by the food's saved serving size itself, so do not do that division yourself."
          ),
        quantity: z
          .number()
          .optional()
          .describe(
            "Number of servings eaten, only when the user did not state a specific amount (defaults to 1). Ignored if amountEaten is provided."
          ),
        serving: servingSchema,
      },
    },
    async (args: AddFoodToDailyCountInput) => {
      try {
        const record = await addFoodToDailyCount(
          userId,
          args.query,
          args.quantity,
          args.serving,
          args.amountEaten
        );
        return {
          content: [
            {
              type: "text",
              text: `Logged for ${record.day}: ${record.order}. ${record.item} (${record.calories} cal, ${record.carbsG}g carbs, ${record.fatG}g fat, ${record.proteinG}g protein). Total so far: ${record.cumulativeCalories} cal, ${record.cumulativeCarbsG}g carbs, ${record.cumulativeFatG}g fat, ${record.cumulativeProteinG}g protein.`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to log food to daily tracker.";
        return { content: [{ type: "text", text: message }] };
      }
    }
  );

  server.registerTool(
    "delete_daily_entry",
    {
      description:
        "Delete a single entry from today's daily tracker without removing the food from the saved food database. Use this to correct an eaten item that was logged by mistake.",
      inputSchema: {
        day: z
          .string()
          .optional()
          .describe("Optional date in yyyy-mm-dd format. Defaults to today in Central Time."),
        order: z.number().describe("The entry order number to remove from the day's tracker."),
      },
    },
    async ({ day, order }: DeleteDailyEntryInput) => {
      try {
        const record = await deleteDailyEntry(userId, day, order);
        return {
          content: [
            {
              type: "text",
              text: `Deleted daily entry ${order} for ${record.day}: ${record.item} (${record.calories} cal).`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete daily entry.";
        return { content: [{ type: "text", text: message }] };
      }
    }
  );

  server.registerTool(
    "delete_food_item",
    {
      description:
        "Delete an existing food item by canonical name. Use this when the user wants to remove a saved food from their database, e.g. 'delete cheese sticks'.",
      inputSchema: deleteFoodItemSchema,
    },
    async ({ item }: DeleteFoodItemInput) => {
      try {
        await deleteFoodItem(userId, item);
        return { content: [{ type: "text", text: `Deleted food item: ${item}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete food item.";
        return { content: [{ type: "text", text: message }] };
      }
    }
  );

  // Also expose the same context as a prompt, for clients that support MCP
  // prompts but don't auto-apply `instructions`. The user inserts it on demand.
  server.registerPrompt(
    "counter_context",
    {
      title: "Calorie & macro counter context",
      description:
        "Insert the always-on rules for the personal calorie/macro counter (targets, macro math, how to allocate the day).",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: SYSTEM_PROMPT } }],
    })
  );

  return server;
}
