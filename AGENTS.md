# AGENTS.md

Orientation for AI coding agents working in this repo. Human-facing docs live in
[README.md](README.md); this file is the fast path to being productive and not
breaking things.

## What this is

An **AI calorie/macro tracker web app** in a personal AWS account:

- **React + Vite + Tailwind SPA** (`web/`) on S3 + CloudFront — a streaming chat UI.
- **A streaming Lambda backend** (`lambda/chat`) that holds the system prompt and
  runs the agentic loop against **OpenAI `gpt-5-nano`**, calling tools in-process.
- **Tools** (`lambda/shared/tools.ts`) backed by DynamoDB plus an internet
  **nutrition search** (`lambda/shared/nutrition-search.ts`) that web-searches
  facts for common foods and returns them in our per-oz/floz storage shape.

The model is meant to be *dumb*; correctness lives in the database and in
deterministic serving-size math (`units.ts`). **One API key = one user**, isolated
in its own DynamoDB partition.

> This was previously a remote MCP server driven by an external client (Joey +
> OpenRouter). That is **gone** — there is no MCP transport, no `@modelcontextprotocol/sdk`,
> no Express, no OpenRouter. The app now owns the model and the loop end-to-end.

## Architecture / data flow

```
Browser (React SPA) → POST /{messages} + Bearer key → Chat Lambda (Function URL, RESPONSE_STREAM)
  → resolveUser(key) → userId
  → agentic loop: streamChatCompletion(messages, tools)  [OpenAI gpt-5-nano]
       ├─ text deltas  → streamed to the browser as SSE
       └─ tool_calls   → dispatch(userId, name, args)  → DynamoDB / web-search
  → SSE: {type:"delta"|"tool"|"error"|"done"}
```

- **Stateless backend.** The browser sends the full conversation each turn;
  durable state (foods, daily log) lives in DynamoDB. Don't add in-memory state
  expecting it to persist across invocations.
- **Streaming.** The chat handler uses `awslambda.streamifyResponse` on a Function
  URL with `InvokeMode.RESPONSE_STREAM`. It is **not** Express — it parses the
  Function-URL event itself. Auth happens *before* the 200 stream opens so failures
  can return 401/403 (see `writeError`).
- **In-process tools.** No network hop for tools; `dispatch()` calls the handler
  directly. `search_nutrition_facts` is the one tool that itself calls OpenAI
  (Responses API + `web_search`).

## File map

| File | Role | Notes when editing |
|------|------|--------------------|
| `bin/iac.ts` | CDK app entry | Reads `.env`: `OPENAI_API_KEY` (required), `ALERT_EMAIL`, `MONTHLY_BUDGET_USD`. |
| `lib/food-tracker-stack.ts` | The whole stack | 3 tables, chat Lambda + streaming URL, S3+CloudFront site, `BucketDeployment`, budget/kill-switch. Stack id stays `FoodTrackerMcpStack`. |
| `lambda/chat/index.ts` | Streaming orchestrator | `awslambda.streamifyResponse`; auth → OpenAI loop → SSE. `MAX_TURNS`/`MAX_HISTORY` guard rails. |
| `lambda/chat/awslambda.d.ts` | Ambient types | Declares the runtime-provided `awslambda` globals. **Force-tracked** despite `.gitignore`'s `*.d.ts`. |
| `lambda/shared/tools.ts` | Tool registry | `TOOLS[]` (name, Zod schema, handler). `toOpenAITools()` (via `z.toJSONSchema`), `dispatch()`. Single source of truth for tools. |
| `lambda/shared/openai.ts` | OpenAI client | `fetch`-based, no SDK. `streamChatCompletion()` (SSE parse + tool-call assembly), `responseJsonSchema()` (web search + strict JSON). Models via env. |
| `lambda/shared/nutrition-search.ts` | Nutrition lookup | `searchNutritionFacts(query)` → `NutritionFacts` shaped like `AddFoodItemInput`. |
| `lambda/shared/system-prompt.ts` | Assistant persona | Single source of truth for behavior + tool policy + daily targets. Edit here, redeploy. |
| `lambda/shared/db.ts` | Food + daily helpers | All `(userId, …)`. Normalization + daily-tracker logic. |
| `lambda/shared/units.ts` | Serving math | `computeQuantityFromServing(serving, amountEaten)`; refuses on unit mismatch. |
| `lambda/shared/users.ts` / `hash.ts` | Auth lookup / hashing | `resolveUser` reads users table by key hash; `hashApiKey` shared with the CLI. |
| `web/src/App.tsx` | Chat UI | Streaming render, tool chips, settings modal (key + backend URL). |
| `web/src/api.ts` | Browser client | `streamChat()` SSE reader, `loadConfig()` (fetches `/config.json`), `toolLabel()`. |
| `types.ts` | Shared types | `FoodItem`, `UserRecord`, tool I/O. |
| `scripts/manage-users.ts` | Admin CLI | `add`/`list`/`revoke`; local, with deploy creds. NOT in the Lambda. |

## Data model (get this right)

- **`food-tracker-items`** — PK `userId`, SK `itemLower` (`trim().toLowerCase()`);
  `item` (display), `aliases[]`, `calories`, optional `proteinG/fatG/carbsG`,
  optional `serving {quantity, unit: "oz"|"floz"}`.
- **`food-tracker-daily`** — PK `userId`, SK `dayOrder` (`YYYY-MM-DD#0001`); per-item
  and cumulative calories/macros for a Central-Time day.
- **`food-tracker-users`** — PK `apiKeyHash` → `{ userId, name, createdAt }`. Hash only.

**Invariants:**
- Every food write MUST include `userId` (PK) + `itemLower` (SK).
- **Never read/write food without a `userId` filter.** `findFoodItem` uses a
  partition `Query`, never a `Scan`. Keep any new query path partition-scoped.
- `toKey()` / `normalizeAliases()` in `db.ts` are the single normalization source;
  `hashApiKey()` in `hash.ts` is the single hashing source. Reuse them.

## Conventions

- **ESM + TypeScript**, `"type": "module"`, `moduleResolution: "bundler"`.
- **TypeScript is the v7 native port.** Its `typeRoots` auto-discovery is flaky, so
  the root `tsconfig.json` sets **`"types": ["node"]`** explicitly — without it the
  whole project fails with "Cannot find name 'process'". If you need another global
  `@types` package, add it to that list.
- **Import shared types without a file extension**: `from "../../types"`.
- Lambda is bundled by CDK `NodejsFunction` (esbuild, minified). Do **not** add
  native/compiled deps — arm64/Graviton2 assumes pure-JS. The OpenAI client is raw
  `fetch` on purpose (no SDK).
- The root `tsconfig.json` **excludes `web/`** (the SPA has its own `web/tsconfig.json`
  with DOM/JSX libs). `npm run build` type-checks the backend only.
- `.gitignore` ignores `*.d.ts`; `lambda/chat/awslambda.d.ts` is un-ignored with a
  `!` negation — keep it that way.

## Gotchas & guardrails

- **Never run `cdk deploy/bootstrap`, `aws …`, `npm run user`, `npm run setup`, or
  anything that mutates AWS unless the human explicitly asks and confirms the target
  account.** `npm run build` and offline `cdk synth` are local and safe. This repo
  targets a *specific personal* account.
- **`OPENAI_API_KEY` is required at runtime** (Lambda env var from `.env`). The app
  deploys without it but every chat request errors until it's set + redeployed.
- **The web app must be built before synth/deploy.** `lib/food-tracker-stack.ts`
  points `BucketDeployment` at `web/dist`; if it's missing, `cdk synth`/`deploy`
  fails on the asset. Run `npm run build:web` first (or `npm run deploy`, which does).
- **Function URL identity.** Changing the chat Lambda's `architecture`/`runtime`
  replaces the function and changes its Function URL. CDK rewrites the site's
  `config.json` on deploy, so the app self-heals — but call it out in a PR.
- **Streaming handler.** Open the 200 SSE stream only after auth. Set CORS headers on
  both the Function URL config and the streamed response. Don't switch it to Express.
- **Free tier.** Tables are `BillingMode.PROVISIONED` on purpose (shared 25 RCU/WCU).
  Don't flip to on-demand or add a VPC/NAT Gateway. CloudFront uses `PRICE_CLASS_100`.
- **Lambda is read-only on the users table** by design — never widen it to write keys.
- **Secrets.** API keys are shown once by `manage-users.ts` and stored as hashes.
  Never log a raw key or the OpenAI key; never commit either.
- **No tests yet.** If you add logic to `db.ts`/`units.ts`, prefer a small harness
  over manual DynamoDB pokes; ask before introducing a test framework.

## Where to make common changes

- **New tool** → add an entry to `TOOLS` in `lambda/shared/tools.ts` (Zod schema +
  `(userId, args)` handler), a helper in `db.ts` if it touches storage, and any new
  shape in `types.ts`. It's automatically exposed to the model — no other wiring.
- **Change the assistant's behavior / targets** → `lambda/shared/system-prompt.ts`.
- **New stored food field** → extend `FoodItem` + `AddFoodItemInput` in `types.ts`,
  the schema in `tools.ts`, and the record built in `db.ts:addFoodItem`.
- **Frontend** → `web/src/App.tsx` + `web/src/api.ts`; rebuild with `npm run build:web`.
- **Infra change** → `lib/food-tracker-stack.ts`; re-check free-tier, key-schema,
  and Function-URL-identity notes above, and update `iam/` if new services are used.
