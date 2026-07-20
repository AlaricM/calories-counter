/**
 * Local dev only. Creates the three DynamoDB tables in LocalStack and loads the
 * seed data from db.sample.json. Idempotent — safe to re-run (e.g. after a
 * LocalStack restart, since its data is in-memory). NOT used in production.
 *
 *   npm run dev:up      # start LocalStack (docker compose)
 *   npm run dev:seed    # this script
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  type KeySchemaElement,
  type AttributeDefinition,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { hashApiKey } from "../lambda/shared/hash";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const ITEMS = process.env.TABLE_NAME ?? "food-tracker-items";
const DAILY = process.env.DAILY_TABLE_NAME ?? "food-tracker-daily";
const USERS = process.env.USERS_TABLE_NAME ?? "food-tracker-users";

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(client);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until LocalStack answers (it takes a few seconds to boot). */
async function waitForLocalStack(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      if (attempt === 1) console.log(`Waiting for LocalStack at ${ENDPOINT} …`);
      await sleep(1000);
    }
  }
  throw new Error(`LocalStack not reachable at ${ENDPOINT}. Is \`npm run dev:up\` running?`);
}

async function createTable(
  name: string,
  keySchema: KeySchemaElement[],
  attrs: AttributeDefinition[]
): Promise<void> {
  const existing = await client.send(new ListTablesCommand({}));
  if (existing.TableNames?.includes(name)) {
    console.log(`  table ${name} already exists`);
    return;
  }
  await client.send(
    new CreateTableCommand({
      TableName: name,
      KeySchema: keySchema,
      AttributeDefinitions: attrs,
      BillingMode: "PAY_PER_REQUEST",
    })
  );
  console.log(`  created table ${name}`);
}

type Seed = {
  users?: { userId: string; name: string; apiKey: string }[];
  items?: Record<string, unknown>[];
  daily?: Record<string, unknown>[];
};

async function main(): Promise<void> {
  await waitForLocalStack();

  console.log("Creating tables …");
  await createTable(
    ITEMS,
    [
      { AttributeName: "userId", KeyType: "HASH" },
      { AttributeName: "itemLower", KeyType: "RANGE" },
    ],
    [
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "itemLower", AttributeType: "S" },
    ]
  );
  await createTable(
    DAILY,
    [
      { AttributeName: "userId", KeyType: "HASH" },
      { AttributeName: "dayOrder", KeyType: "RANGE" },
    ],
    [
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "dayOrder", AttributeType: "S" },
    ]
  );
  await createTable(
    USERS,
    [{ AttributeName: "apiKeyHash", KeyType: "HASH" }],
    [{ AttributeName: "apiKeyHash", AttributeType: "S" }]
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const seed = JSON.parse(readFileSync(join(here, "..", "db.sample.json"), "utf8")) as Seed;
  const createdAt = new Date().toISOString();

  console.log("Loading seed data …");
  for (const u of seed.users ?? []) {
    await doc.send(
      new PutCommand({
        TableName: USERS,
        Item: { apiKeyHash: hashApiKey(u.apiKey), userId: u.userId, name: u.name, createdAt },
      })
    );
    console.log(`  user "${u.name}" (${u.userId}) — API key: ${u.apiKey}`);
  }

  for (const raw of seed.items ?? []) {
    const item = String(raw.item ?? "").trim();
    const aliases = Array.isArray(raw.aliases)
      ? (raw.aliases as string[]).map((a) => a.trim().toLowerCase()).filter(Boolean)
      : [];
    await doc.send(
      new PutCommand({
        TableName: ITEMS,
        Item: { ...raw, item, itemLower: item.toLowerCase(), aliases },
      })
    );
  }
  console.log(`  ${(seed.items ?? []).length} food item(s)`);

  for (const entry of seed.daily ?? []) {
    await doc.send(new PutCommand({ TableName: DAILY, Item: entry }));
  }
  if ((seed.daily ?? []).length) console.log(`  ${seed.daily!.length} daily entr(y/ies)`);

  console.log("\nDone. Point the web app's Settings at the local backend and use an API key above.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
