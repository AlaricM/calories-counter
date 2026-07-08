import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

export interface FoodItem {
  item: string;
  itemLower: string;
  calories: number;
  proteinG?: number;
  fatG?: number;
  carbsG?: number;
  serving?: string;
}

export interface AddFoodItemInput {
  item: string;
  calories: number;
  proteinG?: number;
  fatG?: number;
  carbsG?: number;
  serving?: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export async function addFoodItem(input: AddFoodItemInput): Promise<FoodItem> {
  const record: FoodItem = {
    item: input.item.trim(),
    itemLower: normalize(input.item),
    calories: input.calories,
    ...(input.proteinG !== undefined && { proteinG: input.proteinG }),
    ...(input.fatG !== undefined && { fatG: input.fatG }),
    ...(input.carbsG !== undefined && { carbsG: input.carbsG }),
    ...(input.serving !== undefined && { serving: input.serving }),
  };

  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
  return record;
}

/**
 * Looks up a food item by exact name first (fast, cheap GetItem),
 * then falls back to a substring scan for partial matches.
 * Fine at personal-food-log scale (dozens/hundreds of items).
 */
export async function findFoodItem(query: string, limit = 5): Promise<FoodItem[]> {
  const key = normalize(query);

  const exact = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { itemLower: key } })
  );
  if (exact.Item) return [exact.Item as FoodItem];

  const scan = await doc.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "contains(itemLower, :q)",
      ExpressionAttributeValues: { ":q": key },
      Limit: 100,
    })
  );
  return ((scan.Items as FoodItem[]) ?? []).slice(0, limit);
}
