#!/usr/bin/env node
/**
 * Manage tracker users (API keys). Runs LOCALLY with your AWS deploy
 * credentials — it is not part of the Lambda. The Lambda can only READ the
 * users table; minting/revoking keys happens here.
 *
 *   npm run user -- add --name "Alaric" [--url <SiteUrl>] [--user <existingUserId>] [--only-if-empty]
 *   npm run user -- list
 *   npm run user -- revoke --name "Friend"        # or --user usr_xxxx
 *
 * The DynamoDB client uses your default AWS region/credentials (same chain as
 * the CDK CLI); set AWS_REGION if it differs from your default profile.
 */
import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { hashApiKey } from "../lambda/shared/hash";
import type { UserRecord } from "../types";

const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME ?? "food-tracker-users";

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);

type Args = Record<string, string | boolean>;

/** Minimal flag parser: `--key value` -> {key: value}; bare `--flag` -> {flag: true}. */
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function str(v: string | boolean | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

async function listUsers(): Promise<UserRecord[]> {
  const out = await doc.send(new ScanCommand({ TableName: USERS_TABLE_NAME }));
  return (out.Items as UserRecord[]) ?? [];
}

async function cmdAdd(args: Args): Promise<void> {
  const name = str(args.name);
  if (!name) throw new Error('add requires --name "Some Name"');

  if (args["only-if-empty"]) {
    const existing = await listUsers();
    if (existing.length > 0) {
      console.log(`Users already exist (${existing.length}); skipping first-user creation.`);
      return;
    }
  }

  const userId = str(args.user) || `usr_${randomBytes(6).toString("hex")}`;
  const apiKey = randomBytes(24).toString("hex");
  const record: UserRecord = {
    apiKeyHash: hashApiKey(apiKey),
    userId,
    name,
    createdAt: new Date().toISOString(),
  };
  await doc.send(new PutCommand({ TableName: USERS_TABLE_NAME, Item: record }));

  const base = str(args.url).replace(/\/+$/, "");
  console.log("\n✅ Created user");
  console.log(`   name:   ${name}`);
  console.log(`   userId: ${userId}`);
  console.log("\n🔑 API key (shown ONCE — copy it now, it cannot be recovered):");
  console.log(`   ${apiKey}`);
  console.log("\nHow this person signs in:");
  console.log(`   1. Open the web app: ${base || "<SiteUrl from 'cdk deploy'>"}`);
  console.log("   2. Open ⚙︎ Settings and paste this API key (stored only in their browser).");
}

async function cmdList(): Promise<void> {
  const users = await listUsers();
  if (!users.length) {
    console.log('No users yet. Create one with: npm run user -- add --name "You"');
    return;
  }
  console.log(`\n${users.length} user(s):`);
  for (const u of users) {
    console.log(
      `  ${u.userId}\t${u.name}\t(added ${u.createdAt})\tkeyHash=${u.apiKeyHash.slice(0, 12)}…`
    );
  }
}

async function cmdRevoke(args: Args): Promise<void> {
  const name = str(args.name).toLowerCase();
  const userId = str(args.user);
  if (!name && !userId) {
    throw new Error('revoke requires --name "Name" or --user usr_xxxx');
  }

  const users = await listUsers();
  const targets = users.filter(
    (u) => (userId && u.userId === userId) || (name && u.name.trim().toLowerCase() === name)
  );
  if (!targets.length) {
    console.log("No matching users.");
    return;
  }

  for (const u of targets) {
    await doc.send(
      new DeleteCommand({ TableName: USERS_TABLE_NAME, Key: { apiKeyHash: u.apiKeyHash } })
    );
    console.log(`Revoked key for ${u.name} (${u.userId}).`);
  }
  console.log(
    "Note: their stored food data (partition userId) is left intact — delete it separately if you want it gone."
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "add":
      await cmdAdd(args);
      break;
    case "list":
      await cmdList();
      break;
    case "revoke":
      await cmdRevoke(args);
      break;
    default:
      console.log(
        "Usage: npm run user -- <add|list|revoke> [--name ...] [--user ...] [--url ...] [--only-if-empty]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
