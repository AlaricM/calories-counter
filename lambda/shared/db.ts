import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AddFoodItemInput, DailyTrackerEntry, FoodItem, ServingSize } from "../../types";
import { computeQuantityFromServing, formatServing } from "./units";

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

async function queryUserItems(userId: string, limit = 200): Promise<FoodItem[]> {
  const result = await doc.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "userId" },
      ExpressionAttributeValues: { ":u": userId },
      Limit: limit,
    })
  );
  return (result.Items as FoodItem[]) ?? [];
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

  const items = await queryUserItems(userId);
  return items.filter((item) => matchesQuery(item, key)).slice(0, limit);
}

const FUZZY_MAX_DISTANCE = 0.5;
const FUZZY_MAX_RESULTS = 3;

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

/** Edit distance normalized to [0, 1] by the longer string's length; 0 = identical. */
function normalizedDistance(a: string, b: string): number {
  if (!a.length && !b.length) return 0;
  return levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Closest distance from `query` to an item's canonical name or any of its aliases. */
function bestDistance(item: FoodItem, query: string): number {
  const candidates = [item.itemLower, ...(item.aliases ?? [])];
  return Math.min(...candidates.map((candidate) => normalizedDistance(candidate, query)));
}

export type FuzzyFoodMatch = {
  item: FoodItem;
  similarityPercent: number;
};

/**
 * Fuzzy fallback for when exact/substring matching in `findFoodItem` comes up
 * empty — e.g. the LLM guesses "7% ground beef patties" but the saved alias is
 * "7 ground beef patty". Ranks the whole partition by edit distance to the
 * canonical name or any alias, keeps matches under 50% distance, and returns
 * the closest 3. Intentionally separate from `findFoodItem` (rather than a
 * flag on it) so callers that act on a match automatically — upserting in
 * `addFoodItem`, auto-logging in `addFoodToDailyCount` — can't silently pick up
 * a "close enough" guess instead of a real one.
 */
export async function findFoodItemFuzzy(
  userId: string,
  query: string
): Promise<FuzzyFoodMatch[]> {
  const key = toKey(query);
  const items = await queryUserItems(userId);

  return items
    .map((item) => ({ item, distance: bestDistance(item, key) }))
    .filter(({ distance }) => distance < FUZZY_MAX_DISTANCE)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, FUZZY_MAX_RESULTS)
    .map(({ item, distance }) => ({
      item,
      similarityPercent: Math.round((1 - distance) * 100),
    }));
}

export async function addFoodToDailyCount(
  userId: string,
  query: string,
  quantity = 1,
  serving?: ServingSize,
  amountEaten?: string
): Promise<DailyTrackerEntry> {
  const matched = await findFoodItem(userId, query, 1);
  if (matched.length === 0) {
    throw new Error(`No saved food found matching "${query}". Add it with add_food_item first.`);
  }

  const food = matched[0];

  // Prefer computing the multiplier ourselves from the stated amount rather
  // than trusting an LLM-supplied `quantity` — dividing "6oz eaten" by a
  // saved "2oz" serving is exactly the kind of arithmetic weaker models get
  // wrong or skip. The LLM converts the amount to oz/floz first; we only divide.
  let effectiveQuantity = quantity;
  if (amountEaten) {
    if (!food.serving) {
      throw new Error(
        `"${food.item}" has no saved serving size, so "${amountEaten}" can't be converted to a quantity. Pass "quantity" as a plain number of servings instead.`
      );
    }
    const computed = computeQuantityFromServing(food.serving, amountEaten);
    if (computed === null) {
      throw new Error(
        `Could not reconcile "${amountEaten}" with the saved serving "${formatServing(food.serving)}" for "${food.item}". State the amount in ${food.serving.unit} (${food.serving.unit === "oz" ? "weight" : "volume"}), or pass "quantity" as a plain number of servings instead.`
      );
    }
    effectiveQuantity = computed;
  }

  if (effectiveQuantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

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
  const itemCalories = food.calories * effectiveQuantity;
  const itemProteinG = safeNumber(food.proteinG) * effectiveQuantity;
  const itemFatG = safeNumber(food.fatG) * effectiveQuantity;
  const itemCarbsG = safeNumber(food.carbsG) * effectiveQuantity;
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

export async function deleteDailyEntry(
  userId: string,
  day = getCentralDateKey(),
  order: number
): Promise<DailyTrackerEntry> {
  const dayOrder = toDailySortKey(day, order);
  const existing = await doc.send(
    new GetCommand({ TableName: DAILY_TABLE_NAME, Key: { userId, dayOrder } })
  );
  if (!existing.Item) {
    throw new Error(`Daily entry not found for ${day} order ${order}.`);
  }

  const deleted = existing.Item as DailyTrackerEntry;
  await doc.send(
    new DeleteCommand({ TableName: DAILY_TABLE_NAME, Key: { userId, dayOrder } })
  );

  const later = await doc.send(
    new QueryCommand({
      TableName: DAILY_TABLE_NAME,
      KeyConditionExpression: "#u = :u AND begins_with(#k, :dayPrefix)",
      ExpressionAttributeNames: { "#u": "userId", "#k": "dayOrder" },
      ExpressionAttributeValues: { ":u": userId, ":dayPrefix": `${day}#` },
      ScanIndexForward: true,
    })
  );

  let previousTotals = {
    cumulativeCalories: deleted.order > 1 ? deleted.cumulativeCalories - deleted.calories : 0,
    cumulativeProteinG: deleted.order > 1 ? deleted.cumulativeProteinG - deleted.proteinG : 0,
    cumulativeFatG: deleted.order > 1 ? deleted.cumulativeFatG - deleted.fatG : 0,
    cumulativeCarbsG: deleted.order > 1 ? deleted.cumulativeCarbsG - deleted.carbsG : 0,
  };

  let nextOrder = deleted.order;
  const laterEntries = ((later.Items as DailyTrackerEntry[]) ?? []).filter(
    (entry) => entry.order > order
  );
  for (const entry of laterEntries) {
    const updated: DailyTrackerEntry = {
      ...entry,
      order: nextOrder,
      dayOrder: toDailySortKey(day, nextOrder),
      cumulativeCalories: previousTotals.cumulativeCalories + entry.calories,
      cumulativeProteinG: previousTotals.cumulativeProteinG + entry.proteinG,
      cumulativeFatG: previousTotals.cumulativeFatG + entry.fatG,
      cumulativeCarbsG: previousTotals.cumulativeCarbsG + entry.carbsG,
    };

    await doc.send(new PutCommand({ TableName: DAILY_TABLE_NAME, Item: updated }));
    if (updated.dayOrder !== entry.dayOrder) {
      await doc.send(
        new DeleteCommand({ TableName: DAILY_TABLE_NAME, Key: { userId, dayOrder: entry.dayOrder } })
      );
    }

    previousTotals = {
      cumulativeCalories: updated.cumulativeCalories,
      cumulativeProteinG: updated.cumulativeProteinG,
      cumulativeFatG: updated.cumulativeFatG,
      cumulativeCarbsG: updated.cumulativeCarbsG,
    };
    nextOrder += 1;
  }

  return deleted;
}
