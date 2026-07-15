# AGENTS.md

Orientation for AI coding agents working in this repo. Human-facing docs live in
[README.md](README.md); this file is the fast path to being productive and not
breaking things.

## What this is

A **remote MCP server** that is the long-term memory for a personal calorie/macro
tracker. A cheap LLM (via the Joey MCP client + OpenRouter) calls three tools to
store and recall foods in DynamoDB, so the user never re-specifies a food's
nutrition twice. The LLM is meant to be *dumb*; correctness lives in the database.
Deployed to a personal AWS account with the CDK, sized to stay in AWS's permanent
free tier.

**Multi-tenant: one API key = one user.** Each user's data is isolated in its own
DynamoDB partition. The server contains **no LLM logic and no OpenRouter key** — it
only implements the tools and per-user auth. The client (Joey) runs the agentic loop.

## Architecture / data flow

```
Joey (orchestrator) → OpenRouter (LLM) → decides to call a tool
Joey → HTTPS POST /mcp (+ user's API key) → Lambda Function URL → Express
     → authenticate (key → userId) → MCP transport → tool(userId, …) → DynamoDB
```

- **Auth per request.** `authenticate` (in `index.ts`) extracts the key (Bearer
  header *or* `/mcp/:token` path), hashes it, looks it up in the users table, and
  stashes `res.locals.userId`. Unknown key → 403, missing → 401.
- **Everything is userId-scoped.** `buildServer(userId)` binds the tools; every
  `db.ts` call takes `userId` first. This is the core invariant — see below.
- **Stateless MCP.** A fresh `McpServer` + transport per request
  (`sessionIdGenerator: undefined`). Don't add in-memory state expecting it to
  persist across Lambda invocations.
- **Function URL, not API Gateway.** IAM auth is `NONE` on purpose; the per-user
  API key is the gate. There is no longer any shared `MCP_API_KEY`.

## File map

| File | Role | Notes when editing |
|------|------|--------------------|
| `bin/iac.ts` | CDK app entry | Loads `.env` for optional `ALERT_EMAIL`/`MONTHLY_BUDGET_USD`. No secret needed to deploy. |
| `lib/food-tracker-stack.ts` | The whole stack | 2 tables, Lambda, Function URL, per-table IAM grants, Budgets alarm, one CfnOutput. |
| `lambda/mcp-server/index.ts` | HTTP handler | Express + `serverless-http`; async `authenticate`; routes `/mcp` and `/mcp/:token`. |
| `lambda/mcp-server/mcp.ts` | Tool definitions | `buildServer(userId)`; Zod schemas; thin wrappers over `db.ts`. |
| `lambda/mcp-server/db.ts` | Food-item helpers | `addFoodItem`/`addAlias`/`findFoodItem`, all `(userId, …)`. Normalization lives here. |
| `lambda/mcp-server/users.ts` | Auth lookup | `resolveUser(apiKey)` → reads users table by key hash. |
| `lambda/mcp-server/hash.ts` | `hashApiKey()` | SHA-256; **shared** with the admin CLI so both hash identically. |
| `types.ts` | Shared types | `FoodItem`, `UserRecord`, tool I/O. |
| `scripts/manage-users.ts` | Admin CLI | `add`/`list`/`revoke`. Runs locally with deploy creds, NOT in the Lambda. |
| `scripts/bootstrap.sh` | One-command setup+deploy+first-user | macOS; idempotent. |

## Data model (get this right)

**`food-tracker-items`** — partition `userId`, sort `itemLower`:

```jsonc
{ "userId": "usr_9f2c1a",       // PK: whose food
  "itemLower": "greek yogurt",  // SK: toKey(name) = trim().toLowerCase()
  "item": "Greek yogurt",       // display name, original casing
  "aliases": ["..."],           // normalized + de-duplicated
  "calories": 160, "proteinG": 17, "fatG": 0, "carbsG": 9,  // macros optional
  "serving": "1 container" }    // optional
```

**`food-tracker-users`** — partition `apiKeyHash` → `{ userId, name, createdAt }`.
Only the SHA-256 **hash** of the key is stored.

**Invariants:**
- Every food write MUST include both `userId` (PK) and `itemLower` (SK). Missing
  either throws a DynamoDB `ValidationException`.
- **Never read/write food without a `userId` filter.** `findFoodItem` uses a
  `Query` keyed on `userId` (not a `Scan`), so it structurally cannot return
  another user's rows. If you add a query path, keep it partition-scoped — do not
  reintroduce a full-table `Scan`.
- `toKey()` / `normalizeAliases()` in `db.ts` are the single source of
  normalization; reuse them, don't re-lowercase ad hoc. `hashApiKey()` in
  `hash.ts` is the single source of key hashing.

## Conventions

- **ESM + TypeScript**, `"type": "module"`, `moduleResolution: "bundler"`.
- **Import shared types without a file extension**: `from "../../types"` (not
  `"../../types.ts"` — `tsc --noEmit` rejects `.ts` extensions here; esbuild is
  fine either way).
- Lambda is bundled by CDK `NodejsFunction` (esbuild, minified). Do **not** add
  native/compiled dependencies — arm64/Graviton2 assumes pure-JS deps.
- `tsconfig.json` has no `include`, so `tsc` also type-checks `scripts/` and
  `bin/`. Run `npm run build` after any edit.

## Common commands

```bash
npm run build      # tsc --noEmit — full typecheck, NO AWS calls. Run after edits.
npx cdk synth      # local CloudFormation synth (no secret needed)
npx cdk diff       # what a deploy would change
npm run user -- add --name "X" --url "<McpServerUrl>"   # mint a user + key
npm run user -- list | revoke --name "X"
```

`build` is the cheap, offline correctness check — prefer it for verifying changes.

### Synth without touching an account

`cdk synth` is local, but the CLI resolves the default AWS account via
`sts:GetCallerIdentity` first. To synth with zero AWS contact (e.g. wrong account
active), neutralize the credential chain:

```bash
env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    CDK_DEFAULT_REGION=us-east-1 npx cdk synth --no-lookups --no-notices
```

## Gotchas & guardrails

- **Never run `cdk deploy/bootstrap`, `aws …`, `npm run user`, `npm run setup`, or
  anything that mutates AWS unless the human explicitly asks and confirms the
  target account.** `cdk synth` (as above) and `npm run build` are local and safe.
  This repo targets a *specific personal* account; deploying to the wrong one is
  easy and unwanted.
- **Function URL identity.** Changing the Lambda's `architecture` or `runtime`
  forces a function *replacement*, which changes the Function URL and breaks all
  users' clients. Call this out in any PR that touches those props.
- **Key schema is immutable.** You can't change a table's partition/sort key in
  place — it forces table replacement, and both tables are `RemovalPolicy.RETAIN`
  (so the old table lingers and blocks the rename). Fine on first deploy (no data);
  otherwise it needs a migration.
- **Free tier.** Both tables are `BillingMode.PROVISIONED` on purpose; the free
  25 RCU / 25 WCU is shared account-wide. Don't flip to on-demand or raise
  capacity without a reason. Don't add a VPC/NAT Gateway.
- **Lambda is read-only on the users table** by design. Do not widen that grant to
  let the Lambda write keys — key management is admin-only.
- **Secrets.** API keys are shown once by `manage-users.ts` and stored only as
  hashes. Never log a raw key; never persist one in a fixture or the repo.
- **No tests exist yet.** If you add logic to `db.ts`, prefer a small test harness
  over manual DynamoDB pokes; ask before introducing a test framework.

## Where to make common changes

- **New tool** → Zod schema + `registerTool` in `mcp.ts` (bind `userId`), a helper
  in `db.ts` (`(userId, …)`), and any new shape in `types.ts`.
- **New stored food field** → extend `FoodItem` + `AddFoodItemInput` in `types.ts`,
  the schema in `mcp.ts`, and the record built in `db.ts:addFoodItem`.
- **User/auth change** → `users.ts` (lookup), `index.ts` (`authenticate`),
  `manage-users.ts` (admin ops). Keep `hash.ts` the single hashing source.
- **Infra change** → `lib/food-tracker-stack.ts`; re-check the free-tier,
  key-schema, and Function-URL-identity notes above.
