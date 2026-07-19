import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { UserRecord } from "../../types";
import { hashApiKey } from "./hash";

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME!;

/**
 * Resolve a presented API key to its user, or null if the key is unknown.
 * Looks up by the key's hash — the raw key is never stored or compared.
 */
export async function resolveUser(apiKey: string): Promise<UserRecord | null> {
  const apiKeyHash = hashApiKey(apiKey);
  const result = await doc.send(
    new GetCommand({ TableName: USERS_TABLE_NAME, Key: { apiKeyHash } })
  );
  return (result.Item as UserRecord) ?? null;
}
