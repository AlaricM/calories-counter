import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addAlias, addFoodItem, findFoodItem } from "./db";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { AddAliasInput, AddFoodItemInput, FindFoodItemInput } from "../../types";

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
  serving: z
    .string()
    .optional()
    .describe("Serving size description, e.g. '1 stick' or '100g'"),
};

const addAliasSchema = {
  food: z.string().describe("Canonical name of the existing food item, e.g. 'Greek yogurt'"),
  alias: z.string().describe("Alternative name to add, e.g. '160 cal greek yogurt'"),
};

const findFoodItemSchema = {
  query: z.string().describe("Food name to search for, e.g. 'cheese sticks'"),
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
        "Store a food item with its nutrition info in the personal food database. " +
        "Use this when the user wants to add or define a new food, e.g. " +
        "'add cheese sticks, 50 cal, 6g protein, 2.5g fat'.",
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
        "Supports exact and partial matches, e.g. 'I ate one cheese stick'.",
      inputSchema: findFoodItemSchema,
    },
    async ({ query }: FindFoodItemInput) => {
      const results = await findFoodItem(userId, query);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No food item found matching "${query}".` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
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
