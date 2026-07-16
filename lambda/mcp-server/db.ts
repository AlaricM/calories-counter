import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AddFoodItemInput, DailyTrackerEntry, FoodItem } from "../../types";

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;
const DAILY_TABLE_NAME = process.env.DAILY_TABLE_NAME!;

/** Normalize a name into the table's sort key: trimmed + lowercased. */
function toKey(name: string): string {
  return name.trim().toLowerCase();
}

function getCentralDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Unable to determine Central Time date.");
  }

  return `${year}-${month}-${day}`;
}

function toDailySortKey(day: string, order: number): string {
  return `${day}#${order.toString().padStart(4, "0")}`;
}

function safeNumber(value: number | undefined): number {
  return value ?? 0;
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
  const existing = (await findFoodItem(userId, item, 1))[0];
  const itemLower = existing?.itemLower ?? toKey(item);
  const aliases = normalizeAliases([
    ...(input.aliases ?? []),
    ...(existing?.aliases ?? []),
  ]);

  const record: FoodItem = {
    userId, // partition key — isolates each user's foods in their own partition
    itemLower,
    item, // human-readable name, original casing preserved for display
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

export async function deleteFoodItem(
  userId: string,
  item: string
): Promise<void> {
  const itemLower = toKey(item);
  const existing = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, itemLower } })
  );

  if (!existing.Item) {
    throw new Error(`Food item not found: ${item}`);
  }

  await doc.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { userId, itemLower } })
  );
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

export async function addFoodToDailyCount(
  userId: string,
  query: string,
  quantity = 1,
  serving?: string
): Promise<DailyTrackerEntry> {
  if (quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

  const matched = await findFoodItem(userId, query, 1);
  if (matched.length === 0) {
    throw new Error(`No saved food found matching "${query}". Add it with add_food_item first.`);
  }

  const food = matched[0];
  const day = getCentralDateKey();
  const latest = await doc.send(
    new QueryCommand({
      TableName: DAILY_TABLE_NAME,
      KeyConditionExpression: "#u = :u AND begins_with(#k, :day)",
      ExpressionAttributeNames: { "#u": "userId", "#k": "dayOrder" },
      ExpressionAttributeValues: { ":u": userId, ":day": `${day}#` },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  const previous = (latest.Items as DailyTrackerEntry[] | undefined)?.[0];
  const order = (previous?.order ?? 0) + 1;
  const itemCalories = food.calories * quantity;
  const itemProteinG = safeNumber(food.proteinG) * quantity;
  const itemFatG = safeNumber(food.fatG) * quantity;
  const itemCarbsG = safeNumber(food.carbsG) * quantity;
  const cumulativeCalories = (previous?.cumulativeCalories ?? 0) + itemCalories;
  const cumulativeProteinG = (previous?.cumulativeProteinG ?? 0) + itemProteinG;
  const cumulativeFatG = (previous?.cumulativeFatG ?? 0) + itemFatG;
  const cumulativeCarbsG = (previous?.cumulativeCarbsG ?? 0) + itemCarbsG;

  const record: DailyTrackerEntry = {
    userId,
    dayOrder: toDailySortKey(day, order),
    day,
    order,
    item: food.item,
    calories: itemCalories,
    proteinG: itemProteinG,
    fatG: itemFatG,
    carbsG: itemCarbsG,
    cumulativeCalories,
    cumulativeProteinG,
    cumulativeFatG,
    cumulativeCarbsG,
    serving: serving ?? food.serving,
  };

  await doc.send(new PutCommand({ TableName: DAILY_TABLE_NAME, Item: record }));
  return record;
}

export async function listDailyEntries(
  userId: string,
  day = getCentralDateKey()
): Promise<DailyTrackerEntry[]> {
  const result = await doc.send(
    new QueryCommand({
      TableName: DAILY_TABLE_NAME,
      KeyConditionExpression: "#u = :u AND begins_with(#k, :day)",
      ExpressionAttributeNames: { "#u": "userId", "#k": "dayOrder" },
      ExpressionAttributeValues: { ":u": userId, ":day": `${day}#` },
      ScanIndexForward: true,
    })
  );
  return (result.Items as DailyTrackerEntry[]) ?? [];
}
