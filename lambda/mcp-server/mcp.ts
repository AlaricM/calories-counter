import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addFoodItem, findFoodItem } from "./db";

/**
 * Builds a fresh MCP server + tool set. Called once per request since
 * this Lambda runs stateless (sessionIdGenerator: undefined) — see index.ts.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "food-tracker", version: "0.1.0" });

  server.tool(
    "add_food_item",
    "Store a food item with its nutrition info in the personal food database. " +
      "Use this when the user wants to add or define a new food, e.g. " +
      "'add cheese sticks, 50 cal, 6g protein, 2.5g fat'.",
    {
      item: z.string().describe("Name of the food item, e.g. 'cheese sticks'"),
      calories: z.number().describe("Calories per serving"),
      proteinG: z.number().optional().describe("Protein per serving, in grams"),
      fatG: z.number().optional().describe("Fat per serving, in grams"),
      carbsG: z.number().optional().describe("Carbohydrates per serving, in grams"),
      serving: z
        .string()
        .optional()
        .describe("Serving size description, e.g. '1 stick' or '100g'"),
    },
    async (args) => {
      const record = await addFoodItem(args);
      return {
        content: [{ type: "text", text: `Saved: ${JSON.stringify(record)}` }],
      };
    }
  );

  server.tool(
    "find_food_item",
    "Look up a previously saved food item's nutrition info by name. " +
      "Supports exact and partial matches, e.g. 'I ate one cheese stick'.",
    {
      query: z.string().describe("Food name to search for, e.g. 'cheese sticks'"),
    },
    async ({ query }) => {
      const results = await findFoodItem(query);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No food item found matching "${query}".` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  return server;
}
