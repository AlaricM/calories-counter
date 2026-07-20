# AGENTS.md

Orientation for AI coding agents working in this repo. Human-facing docs live in
[README.md](README.md); this file is the fast path to being productive and not
breaking things.

## What this is

An **AI calorie/macro tracker web app** in a personal AWS account:

- **React + Vite + Tailwind SPA** (`web/`) on S3 + CloudFront — a streaming chat UI.
- **A streaming Lambda backend** (`lambda/chat`) that runs a **deterministic
  pipeline** around **OpenAI `gpt-5-nano`** (see below), not a free-form agent loop.
- **Deterministic workflows** (`lambda/shared/workflows.ts`) backed by DynamoDB
  (`db.ts`), a code-only macro validator (`nutrition.ts`), and an internet
  **nutrition search** (`nutrition-search.ts`) in our per-oz/floz storage shape.

The model is deliberately kept *dumb and narrow*: it only classifies intent and
phrases the reply. Correctness lives in the database, in deterministic serving-size
math (`units.ts`), and in the 4/4/9 validator (`nutrition.ts`). **One API key =
one user**, isolated in its own DynamoDB partition.

> This was previously (1) a remote MCP server (Joey + OpenRouter) and then (2) a
> single free-form OpenAI tool-calling loop with one big system prompt. Both are
> **gone**. There is no MCP transport, no `zod` tool registry, no `dispatch()`, no
> `system-prompt.ts`. Each LLM call now has one narrow job; plain TypeScript owns
> the control flow, math, and validation.

## Architecture / data flow

```
Browser (React SPA) → POST /{messages} + Bearer key → Chat Lambda (Function URL, RESPONSE_STREAM)
  → resolveUser(key) → userId
  → 1. parseIntent(history)          [LLM, strict JSON]   → { intent, items, … }
  → 2. runWorkflow(userId, intent, emit)   [plain TypeScript]
         ├─ db.ts (find/add/log/list/delete)            → DynamoDB
         ├─ reconcileMacros()  [no LLM]                 → 4/4/9 validation
         ├─ searchNutritionFacts()  [LLM, web_search]   → per-oz/floz facts
         ├─ checkPlausibility()  [LLM, only if flagged] → search / ask / accept
         └─ emit("<tool_name>", "start"|"end")          → SSE tool chips
       → returns a structured WorkflowResult
  → 3. narrateResult(history, result) [LLM, streamed]   → SSE text deltas
  → SSE: {type:"delta"|"tool"|"error"|"done"}
```

- **Pipeline, not an agent.** The LLM never sequences tools or does math. Intent
  → deterministic workflow → validation → narration. Keep each LLM call single-
  purpose; put logic/branching/CRUD in `workflows.ts`, not in a prompt.
- **Confirm before writing.** A web-looked-up food is returned as a `proposal`
  (no DB write); it's saved+logged only on the next turn's `confirm`. That pending
  state lives in the conversation history (the backend is stateless), so
  `parseIntent` re-reads the prior proposal to build the `confirm` — no server
  session. Known/complete foods and explicit user numbers write directly.
- **Stateless backend.** The browser sends the full conversation each turn;
  durable state (foods, daily log) lives in DynamoDB. Don't add in-memory state
  expecting it to persist across invocations.
- **Streaming.** The chat handler uses `awslambda.streamifyResponse` on a Function
  URL with `InvokeMode.RESPONSE_STREAM`. It is **not** Express — it parses the
  Function-URL event itself. Auth happens *before* the 200 stream opens so failures
  can return 401/403 (see `writeError`).
- **Tool-chip names are a UI contract.** `emit()` uses the 8 legacy names
  (`find_food_item`, `add_food_item`, `add_food_to_daily_count`, `add_alias`,
  `list_daily_entries`, `delete_daily_entry`, `delete_food_item`,
  `search_nutrition_facts`); `web/src/api.ts:toolLabel()` maps them to chip labels.
  Reuse those names for real data ops; internal LLM steps emit no chip.

## File map

| File | Role | Notes when editing |
|------|------|--------------------|
| `bin/iac.ts` | CDK app entry | Reads `.env`: `OPENAI_API_KEY` (required), `ALERT_EMAIL`, `MONTHLY_BUDGET_USD`. |
| `lib/food-tracker-stack.ts` | The whole stack | 3 tables, chat Lambda + streaming URL, S3+CloudFront site, `BucketDeployment`, budget/kill-switch. Stack id stays `FoodTrackerMcpStack`. |
| `lambda/chat/index.ts` | Streaming shell | `awslambda.streamifyResponse`; auth → `parseIntent` → `runWorkflow` → `narrateResult` → SSE. `MAX_HISTORY` guard rail. |
| `lambda/chat/awslambda.d.ts` | Ambient types | Declares the runtime-provided `awslambda` globals. **Force-tracked** despite `.gitignore`'s `*.d.ts`. |
| `lambda/shared/intent.ts` | Orchestrator LLM | `parseIntent(history)` → strict-JSON `Intent`. Owns its prompt. Classifies + extracts; **no math, no invented numbers**. |
| `lambda/shared/workflows.ts` | Deterministic control flow | `runWorkflow(userId, intent, emit)` → `WorkflowResult`. One fn per intent; sequences db/search/validation. **Where logic goes.** |
| `lambda/shared/nutrition.ts` | Macro validator (no LLM) | `reconcileMacros()` (4/4/9: fill 1 missing / flag impossible / suspect field), `computeRemaining()`. Pure — unit-tested. |
| `lambda/shared/sanity.ts` | Plausibility LLM | `checkPlausibility()` → `{status, suspected_field, action}`. Owns its prompt. World-knowledge only; no DB, no math, no tools. |
| `lambda/shared/responder.ts` | Narrate-only LLM | `narrateResult(history, result)` streams the reply. Owns its prompt. **Only phrases pre-computed numbers.** |
| `lambda/shared/targets.ts` | Daily targets | Plain data `TARGETS`. Edit your numbers here, redeploy. |
| `lambda/shared/openai.ts` | OpenAI client | `fetch`-based, no SDK. `streamChatCompletion()` (tools optional), `responseJsonSchema()` (strict JSON + web search). Models via env. |
| `lambda/shared/nutrition-search.ts` | Nutrition lookup | `searchNutritionFacts(query)` → `NutritionFacts`. Its result must pass `reconcileMacros` before any save. |
| `lambda/shared/db.ts` | Food + daily helpers | All `(userId, …)`. Normalization + daily-tracker logic. Unchanged by the pipeline refactor. |
| `lambda/shared/units.ts` | Serving math | `computeQuantityFromServing(serving, amountEaten)`; refuses on unit mismatch. Unit-tested. |
| `lambda/shared/users.ts` / `hash.ts` | Auth lookup / hashing | `resolveUser` reads users table by key hash; `hashApiKey` shared with the CLI. |
| `web/src/App.tsx` | Chat UI | Streaming render, tool chips, settings modal (key + backend URL). **Unchanged — do not edit for backend work.** |
| `web/src/api.ts` | Browser client | `streamChat()` SSE reader, `loadConfig()`, `toolLabel()` (the 8 chip names). The wire contract the backend must preserve. |
| `types.ts` | Shared domain types | `FoodItem`, `DailyTrackerEntry`, `UserRecord`, tool I/O. Pipeline types are co-located in their modules. |
| `scripts/manage-users.ts` | Admin CLI | `add`/`list`/`revoke`; local, with deploy creds. NOT in the Lambda. |
| `lambda/shared/*.test.ts` | Unit tests | `vitest run` (`npm test`). Cover `nutrition.ts` + `units.ts` (deterministic core). |

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
- **Local dev (no AWS).** `npm run dev:up` (LocalStack/DynamoDB in Docker, pinned to
  the free `localstack/localstack:3`) → `dev:seed` (tables + `db.sample.json`) →
  `dev:api` (real handler via an `awslambda` shim in `scripts/dev-server.ts`, :8787)
  → `dev:web` (Vite, :5173). Set Settings → `http://localhost:8787` + `dev-key`.
  `AWS_ENDPOINT_URL` redirects DynamoDB to LocalStack and is **only** ever set in
  local dev — never wire it into the stack. OpenAI is still remote (needs a key).
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
- **Tests exist now (vitest).** `npm test` runs `lambda/**/*.test.ts`. When you add
  or change logic in `nutrition.ts` / `units.ts` (the deterministic core), add a
  failure-case test alongside it. The LLM-driven modules (`intent`/`sanity`/
  `responder`) aren't unit-tested (they'd need a live model) — keep their prompts
  narrow instead.

## Where to make common changes

- **New capability / user action** → add a value to `IntentName` + its fields in
  `lambda/shared/intent.ts` (schema + prompt line), add a `case` and a handler
  function in `lambda/shared/workflows.ts`, and a `db.ts` helper if it touches
  storage. If it surfaces a new tool chip, use an existing `emit()` name or add the
  label to `web/src/api.ts:toolLabel()` (a rare, deliberate frontend touch).
- **Change your daily targets** → `lambda/shared/targets.ts`.
- **Change how a step behaves** → that step's own prompt: `intent.ts` (what gets
  parsed), `sanity.ts` (plausibility calls), `responder.ts` (reply tone).
- **Change macro/validation rules** → `lambda/shared/nutrition.ts` (+ a test).
- **New stored food field** → extend `FoodItem` + `AddFoodItemInput` in `types.ts`,
  the record built in `db.ts:addFoodItem`, and the extraction in `intent.ts`/
  `workflows.ts` if the model should populate it.
- **Frontend** → `web/src/App.tsx` + `web/src/api.ts`; rebuild with `npm run build:web`.
- **Infra change** → `lib/food-tracker-stack.ts`; re-check free-tier, key-schema,
  and Function-URL-identity notes above, and update `iam/` if new services are used.
