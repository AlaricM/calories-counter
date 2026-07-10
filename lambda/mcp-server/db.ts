import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AddFoodItemInput, FoodItem } from "../../types";

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

export async function addFoodItem(input: AddFoodItemInput): Promise<FoodItem> {
  const aliases = Array.from(new Set((input.aliases ?? []).map((a) => a.trim().toLowerCase())));
  const record: FoodItem = {
    item: input.item.trim().toLowerCase(),
    aliases,
    calories: input.calories,
    ...(input.proteinG !== undefined && { proteinG: input.proteinG }),
    ...(input.fatG !== undefined && { fatG: input.fatG }),
    ...(input.carbsG !== undefined && { carbsG: input.carbsG }),
    ...(input.serving !== undefined && { serving: input.serving }),
  };

  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
  return record;
}

function matchesQuery(item: FoodItem, query: string): boolean {
  if (item.item.includes(query)) return true;
  return (item.aliases ?? []).some((alias) => alias.includes(query));
}

export async function addAlias(food: string, alias: string): Promise<FoodItem> {
  const trimmedAlias = alias.trim().toLowerCase();
  if (!trimmedAlias) {
    throw new Error("Alias cannot be empty.");
  }

  const itemLower = food.trim().toLowerCase();
  const result = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { item: itemLower } })
  );
  if (!result.Item) {
    throw new Error(`Food item not found: ${food}`);
  }

  const record = result.Item as FoodItem;
  const aliases:string[] = record.aliases ? Array.from(new Set(record.aliases.map(a => a.trim().toLowerCase()))) : [];
  const updated: FoodItem = { ...record, aliases };

  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
  return updated;
}

/**
 * Looks up a food item by exact name first (fast, cheap GetItem),
 * then falls back to a substring scan for partial matches.
 * Fine at personal-food-log scale (dozens/hundreds of items).
 */
export async function findFoodItem(query: string, limit = 5): Promise<FoodItem[]> {
  const key = query.trim().toLowerCase();

  const exact = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { itemLower: key } })
  );
  if (exact.Item) return [exact.Item as FoodItem];

  const scan = await doc.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 200,
    })
  );
  return ((scan.Items as FoodItem[]) ?? [])
    .filter((item) => matchesQuery(item, key))
    .slice(0, limit);
}
