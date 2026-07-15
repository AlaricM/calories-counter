import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AddFoodItemInput, FoodItem } from "../../types";

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

/** Normalize a name into the table's sort key: trimmed + lowercased. */
function toKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Lowercase, trim, drop empties, and de-duplicate a list of aliases. */
function normalizeAliases(aliases: readonly string[] | undefined): string[] {
  return Array.from(
    new Set((aliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))
  );
}

export async function addFoodItem(
  userId: string,
  input: AddFoodItemInput
): Promise<FoodItem> {
  const item = input.item.trim();
  const record: FoodItem = {
    userId, // partition key — isolates each user's foods in their own partition
    itemLower: toKey(item), // sort key
    item, // human-readable name, original casing preserved for display
    aliases: normalizeAliases(input.aliases),
    calories: input.calories,
    ...(input.proteinG !== undefined && { proteinG: input.proteinG }),
    ...(input.fatG !== undefined && { fatG: input.fatG }),
    ...(input.carbsG !== undefined && { carbsG: input.carbsG }),
    ...(input.serving !== undefined && { serving: input.serving }),
  };

  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
  return record;
}

export async function addAlias(
  userId: string,
  food: string,
  alias: string
): Promise<FoodItem> {
  const trimmedAlias = alias.trim().toLowerCase();
  if (!trimmedAlias) {
    throw new Error("Alias cannot be empty.");
  }

  const itemLower = toKey(food);
  const result = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, itemLower } })
  );
  if (!result.Item) {
    throw new Error(`Food item not found: ${food}`);
  }

  const record = result.Item as FoodItem;
  const aliases = normalizeAliases([...(record.aliases ?? []), trimmedAlias]);
  const updated: FoodItem = { ...record, aliases };

  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
  return updated;
}

function matchesQuery(item: FoodItem, query: string): boolean {
  if (item.itemLower.includes(query)) return true;
  return (item.aliases ?? []).some((alias) => alias.includes(query));
}

/**
 * Look up one user's food by exact sort-key match first (cheap GetItem), then
 * fall back to a Query over just that user's partition + substring match. The
 * Query is keyed on userId, so results can never include another user's items —
 * isolation is structural, not a filter that could be forgotten.
 */
export async function findFoodItem(
  userId: string,
  query: string,
  limit = 5
): Promise<FoodItem[]> {
  const key = toKey(query);

  const exact = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, itemLower: key } })
  );
  if (exact.Item) return [exact.Item as FoodItem];

  const result = await doc.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "userId" },
      ExpressionAttributeValues: { ":u": userId },
      Limit: 200,
    })
  );
  return ((result.Items as FoodItem[]) ?? [])
    .filter((item) => matchesQuery(item, key))
    .slice(0, limit);
}
