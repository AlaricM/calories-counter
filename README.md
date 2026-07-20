# calorie-tracker

A tiny **AI calorie & macro tracker** you talk to like ChatGPT. Tell it what you
ate in plain words; it looks up nutrition facts (from your own database, or the
open web when it doesn't know a food), keeps a running daily log, and tells you
what you have left against your targets — all backed by **your own DynamoDB**.

The whole point is to make logging effortless *and* reliable: the model only
understands what you mean and phrases the reply — it never does the arithmetic or
decides what's correct. Intent parsing, a deterministic macro validator, the
database, and serving-size math do the real work, so a weak model can't drop a
constraint.

It's three things, all in your personal AWS account:

- **A React web app** (static, on S3 + CloudFront) — a clean streaming chat UI.
- **A streaming Lambda backend** — a small **deterministic pipeline** around
  **OpenAI `gpt-5-nano`**: one call classifies your intent, plain TypeScript
  workflows sequence the database/search/validation, and one call narrates the
  result. Each model call has a single, narrow job.
- **An internet nutrition search** — web-searches nutrition facts for common
  foods (ribeye, oatmeal, …) and converts them to our per-oz/floz storage shape,
  used automatically when a food is unknown or your data is incomplete. Its output
  always passes through the deterministic validator before it can be saved.

**Multi-user:** one API key = one user. Each person's food data is completely
isolated in its own DynamoDB partition. Add or revoke users anytime, no redeploy.

Everything AWS-side runs in the **Always-Free tier** (Lambda + DynamoDB) or the
CloudFront free tier, so at personal scale AWS costs **~$0/month**. The only real
cost is OpenAI usage, and `gpt-5-nano` is very cheap.

## How it works

```
Browser (React app on CloudFront + S3, HTTPS)
  │  POST { messages }  +  Authorization: Bearer <API key>      ⟵ SSE stream back
  ▼
Chat Orchestrator Lambda  (Function URL, RESPONSE_STREAM, gpt-5-nano)
  ├─ resolve API key → userId                              (users table, read-only)
  ├─ 1. parseIntent()  → { intent, items, … }              (one LLM call; no math)
  ├─ 2. runWorkflow()  → plain TypeScript control flow:
  │        find/add/log/list/delete            → DynamoDB
  │        reconcileMacros()                   → deterministic 4/4/9 validation
  │        searchNutritionFacts()              → OpenAI Responses web_search
  │        checkPlausibility()  (only if a value looks off)  → one narrow LLM call
  │        → emits tool-chip events + returns a fully-computed result
  └─ 3. narrateResult() → one LLM call that only phrases the result, streamed back
```

The browser holds the conversation and sends it each turn; the backend is
**stateless** (durable state — foods and the daily log — lives in DynamoDB). The
API key is stored only in the browser (localStorage) and sent as a Bearer header.

### Why a pipeline instead of one agent

The model used to run a free-form tool-calling loop and was told, in prose, to
reconcile macros, convert servings, and not invent numbers — and it regularly
dropped one of those. Now responsibilities are split so each step is small and
checkable:

- **Intent parser** (LLM) — decides *what you want* and copies any numbers you
  stated verbatim. It never computes or invents a value.
- **Workflows** (plain TypeScript) — sequence the database/search calls, one
  action per turn, so there are no accidental extra writes.
- **Macro validator** (`reconcileMacros`, no LLM) — enforces
  `calories ≈ 4·protein + 4·carbs + 9·fat`: fills a single missing value, and
  flags impossible combinations (e.g. 70 g fat in a 110-cal serving).
- **Sanity check** (LLM, only when needed) — a real-world plausibility judgment
  that can trigger a web lookup; it can't touch the database or do math.
- **Responder** (LLM) — phrases the already-computed result. Every number it says
  came from code.

**Confirm before writing.** When a food isn't saved yet, the app looks it up,
validates it, and *proposes* it — it saves and logs only after you say yes. That
confirmation is carried in the conversation itself, so the stateless backend
needs no server-side session.

Typical flow: *"I ate 6oz ribeye"* → look up (miss) → web search → validate →
"Found ribeye 4oz = 280 cal, 25g protein… save & log 6oz?" → *"yes"* → saved +
logged. The server divides 6oz by the saved serving to get the multiplier, so the
model never does the arithmetic.

### Serving-size math (why it's reliable)

Servings are stored as a precise weight (`oz`) or volume (`floz`), never freeform
text. When you report an amount, the intent parser restates it in oz/floz and the
server divides it by the saved serving to get the multiplier — deterministic, and
it refuses on a unit mismatch instead of guessing (see
[`lambda/shared/units.ts`](lambda/shared/units.ts)).

### Macro validation (the 4/4/9 rule, in code)

[`lambda/shared/nutrition.ts`](lambda/shared/nutrition.ts) enforces
`calories ≈ 4·protein + 4·carbs + 9·fat` deterministically — the model is never
asked to do this arithmetic. Given any three of the four values it computes the
fourth (e.g. *150 cal, 30 g protein, 3 g fat* → *~0.8 g carbs*); given all four it
checks they reconcile within tolerance and, when they don't, names the field most
likely wrong (e.g. *110 cal, 70 g fat, …* → invalid, suspect **fat**). Every value
— whether you typed it or it came from the web search — passes through this gate
before it can be saved. Covered by
[`lambda/shared/nutrition.test.ts`](lambda/shared/nutrition.test.ts) (`npm test`).

### Data model — three DynamoDB tables

**`food-tracker-items`** — partition `userId`, sort `itemLower` (normalized name):

```jsonc
{ "userId": "usr_9f2c1a", "itemLower": "greek yogurt", "item": "Greek yogurt",
  "aliases": ["160 cal greek yogurt"],
  "calories": 160, "proteinG": 17, "fatG": 0, "carbsG": 9,   // macros optional
  "serving": { "quantity": 6, "unit": "oz" } }               // optional; oz or floz
```

A lookup is a `Query` on the user's partition, so results can **never** include
another user's items — isolation is structural, not a filter that could be forgotten.

**`food-tracker-daily`** — partition `userId`, sort `dayOrder` (`day#order`): each
logged item for a Central-Time day, with per-item and cumulative calories/macros.

**`food-tracker-users`** — partition `apiKeyHash` → `{ userId, name, createdAt }`.
Only the **SHA-256 hash** of a key is stored, so a table read can't recover a
usable credential. The Lambda has **read-only** access here; keys are minted only
by the admin CLI with your deploy credentials.

## Repo layout

```
calorie-tracker/
├── bin/iac.ts                     CDK app entry (reads .env: OPENAI_API_KEY, cost alerts)
├── lib/food-tracker-stack.ts      CDK stack: 3 tables + chat Lambda + streaming URL +
│                                   S3/CloudFront site + BucketDeployment + budget guardrail
├── lambda/
│   ├── chat/index.ts              Streaming shell: auth → parseIntent → runWorkflow → narrate → SSE
│   ├── chat/awslambda.d.ts        Ambient types for the Lambda streaming globals
│   └── shared/
│       ├── intent.ts              Orchestrator LLM: classify intent + extract fields (own prompt)
│       ├── workflows.ts           Deterministic control flow, one function per intent
│       ├── nutrition.ts           Deterministic 4/4/9 validation + remaining-vs-targets (no LLM)
│       ├── sanity.ts              Plausibility LLM: is this believable for that food? (own prompt)
│       ├── responder.ts           Narrate-only LLM: phrases the computed result, streamed (own prompt)
│       ├── targets.ts             Your daily targets as plain data (EDIT here)
│       ├── openai.ts              fetch-based OpenAI client (streaming chat + strict-JSON/web search)
│       ├── nutrition-search.ts    Web-search nutrition lookup → per-oz/floz facts
│       ├── db.ts                  Food-item + daily helpers (all userId-scoped)
│       ├── units.ts               amountEaten → serving-multiplier math
│       ├── users.ts               resolve API key → user
│       └── hash.ts                SHA-256 of an API key (shared with the admin CLI)
├── web/                           React + Vite + Tailwind chat app (builds to web/dist)
│   └── src/{App.tsx, api.ts, main.tsx, index.css}
├── types.ts                       Shared domain types
├── scripts/{manage-users.ts, bootstrap.sh,
│            dev-server.ts,        Local backend: runs the real handler via an awslambda shim (:8787)
│            dev-seed.ts}          Local: create tables in LocalStack + load db.sample.json
├── docker-compose.yml            Local: LocalStack (DynamoDB) for `npm run dev:up`
├── db.sample.json                Local: dev user + seed food library
├── iam/                           Least-privilege deploy/runtime policies (see iam/README.md)
└── .env.example                   OPENAI_API_KEY (+ optional cost alerts)
```

---

# Local development (run the whole app on your machine)

Run the full app locally with **no AWS account** — LocalStack (Docker) provides
DynamoDB, the chat backend runs as a local Node process, and Vite serves the UI.
The one thing that isn't local is **OpenAI** (there's no local model): set
`OPENAI_API_KEY` in `.env` for real replies, or the app runs but chat requests
return an error, exactly like an un-keyed deploy.

> Why not run the Lambda in LocalStack too? The app relies on a **streaming**
> Function URL (`RESPONSE_STREAM`) plus CloudFront/S3/Budgets, which LocalStack's
> community edition doesn't emulate. Running the *real* handler
> ([`lambda/chat/index.ts`](lambda/chat/index.ts)) as a local process — via a tiny
> `awslambda` streaming shim in [`scripts/dev-server.ts`](scripts/dev-server.ts) —
> gives true SSE, instant reload, and the exact production code path.

**One-time per machine:** Docker Desktop running, then `cp .env.example .env` and
(optionally) set `OPENAI_API_KEY`.

```bash
npm run dev:up      # start LocalStack (DynamoDB) in Docker  [pinned to the free 3.x community image]
npm run dev:seed    # create the 3 tables + load db.sample.json (idempotent; re-run after a restart)
npm run dev:api     # start the chat backend on http://localhost:8787   (terminal A)
npm run dev:web     # start the React app on   http://localhost:5173    (terminal B)
```

Then open <http://localhost:5173>, click **⚙︎ Settings**, and set **Backend URL**
`http://localhost:8787` and **API key** `dev-key` (both from `db.sample.json`,
saved in your browser). Edit [`db.sample.json`](db.sample.json) to change the
seeded foods/users and re-run `npm run dev:seed`. Tear down with `npm run dev:down`
(DynamoDB data is in-memory, so it resets each time).

The local backend talks to LocalStack via `AWS_ENDPOINT_URL` (honored by
[`db.ts`](lambda/shared/db.ts) / [`users.ts`](lambda/shared/users.ts)); that env
var is never set in production, so deploys are unaffected.

---

# From scratch: zero to running (deploy to AWS)

Steps 1–4 are **manual** (you can't script an AWS account or an OpenAI key).
Everything after is one command: [`scripts/bootstrap.sh`](scripts/bootstrap.sh).

## Step 1 — Create an AWS account & secure the root user

Sign up at <https://portal.aws.amazon.com/billing/signup>, then sign in as root →
**Security credentials** → enable **MFA**. Stop using root after that.

## Step 2 — Create a non-root admin user (IAM hygiene)

Console → **IAM** → **Users** → **Create user** (e.g. `cdk-deployer`). For a solo
account the pragmatic choice is the AWS-managed **`AdministratorAccess`** policy
(tighten later — see [`iam/README.md`](iam/README.md)). Enable **MFA**, then
**Create access key** → *CLI* and copy the key ID + secret.

## Step 3 — Point the AWS CLI at that user

```bash
brew install awscli    # if needed
aws configure          # paste the key/secret; region e.g. us-east-1; output json
aws sts get-caller-identity   # must print your account ID
```

## Step 4 — Get an OpenAI API key

Create one at <https://platform.openai.com/api-keys>. You'll put it in `.env` as
`OPENAI_API_KEY` (the bootstrap script creates `.env` and reminds you).

## Step 5 — Everything else, in one command

```bash
./scripts/bootstrap.sh          # or: npm run setup
```

That script (macOS, idempotent) installs Node/AWS CLI if missing, `npm ci`s,
**builds the React app**, `cdk bootstrap`s (first time only) and `cdk deploy`s,
then mints your first user + API key and prints it. Copy the **`SiteUrl`** it
prints, open it, click **⚙︎ Settings**, and paste your API key.

### …or do it manually

```bash
cp .env.example .env            # then set OPENAI_API_KEY=...
npm ci
npm run build:web               # build the React app into web/dist
npx cdk bootstrap               # first time per account/region only
npx cdk deploy                  # prints SiteUrl + ChatApiUrl
npm run user -- add --name "Your Name" --url "<SiteUrl>"   # prints your key once
```

> `npm run deploy` is a shortcut for `npm run build:web && cdk deploy`.

## Managing users (giving a friend a key)

The admin CLI runs locally with your AWS credentials (the Lambda can't mint keys):

```bash
npm run user -- add --name "Jane" --url "<SiteUrl>"   # prints their key ONCE
npm run user -- list                                  # no secrets shown
npm run user -- revoke --name "Jane"                  # deletes the key; food data kept
```

Each `add` mints a new user with isolated data. (`--user <userId>` gives someone a
second key that shares existing data.) An API key is a password to that user's
data — it's shown only once.

## Tuning the assistant (targets + prompts)

- **Your daily targets** are plain data in
  [`lambda/shared/targets.ts`](lambda/shared/targets.ts) — edit the numbers and
  `npx cdk deploy`. "What's left today" is computed from these in code, never by
  the model.
- **How each step behaves** lives in that step's own module, one prompt per
  responsibility: the intent classifier in
  [`lambda/shared/intent.ts`](lambda/shared/intent.ts), the plausibility check in
  [`lambda/shared/sanity.ts`](lambda/shared/sanity.ts), and the reply's tone in
  [`lambda/shared/responder.ts`](lambda/shared/responder.ts).

To trade cost/quality, override `OPENAI_CHAT_MODEL` / `OPENAI_SEARCH_MODEL` (see
`.env.example`).

## Security

- **Per-user isolation.** Food data is partitioned by `userId`; lookups are a
  `Query` on that partition, so one user physically cannot read another's data.
- **Keys stored hashed.** The users table holds only `SHA-256(key)`; keys are
  shown once at creation. The key lives only in the user's browser.
- **HTTPS for the credential.** The site is served over CloudFront HTTPS (private
  S3 bucket + Origin Access Control), never a plain-HTTP S3 endpoint, so the API
  key is never typed into an insecure page.
- **Runtime least privilege.** The chat Lambda gets `Get/Put/Query/Delete` on the
  items/daily tables and **`GetItem` only** on the users table — a compromised
  Lambda still can't mint keys. It reaches OpenAI over the internet (no IAM).
- **Deploy least privilege.** Scoped deploy/exec policies + a permissions boundary
  are in [`iam/`](iam/README.md) — apply them to shrink a leaked credential's
  blast radius to this stack.
- **`OPENAI_API_KEY`** is injected as a Lambda env var from `.env` (kept out of
  git). That's $0 and simplest for a personal app; for stricter handling swap in an
  SSM SecureString and grant the Lambda `ssm:GetParameter`.

## Cost

AWS: Lambda + DynamoDB sit in the **permanent** Always-Free tier (25 GB + 25 RCU +
25 WCU shared account-wide; the three small tables provision well under that), and
CloudFront's free tier (1 TB out / month) covers personal use. A personal tracker
realistically costs **~$0/month on AWS**. As a canary, the stack provisions an
**AWS Budgets** alarm (default **$1/month**) that emails you if the AWS bill ever
moves; set `ALERT_EMAIL` in `.env` to enable it plus a kill switch.

**OpenAI is billed separately** by OpenAI. `gpt-5-nano` is inexpensive, but the
nutrition web-search adds tokens; watch usage in the OpenAI dashboard. Avoid adding
a VPC/NAT Gateway — the most common source of surprise AWS charges, and unneeded here.

## Redeploying — things that change a URL ⚠️

- Changing the chat Lambda's **architecture** or **runtime** forces a function
  *replacement*, which changes the **Function URL** (`ChatApiUrl`). CDK rewrites
  the site's `config.json` on the next deploy, so the app keeps working — but a
  standalone consumer of the API would need the new URL.
- Changing a table's **key schema** replaces the table; both are
  `RemovalPolicy.RETAIN`, so the old one lingers and blocks the rename. Fine on a
  fresh deploy; otherwise it needs a migration.

## Useful commands

| Command | What it does |
|---------|--------------|
| `npm run setup` | Full from-scratch install + build + deploy + first user (macOS) |
| `npm run build` | Type-check the backend (`tsc --noEmit`) — no AWS calls |
| `npm test` | Run the backend unit tests (validation + serving math) with vitest — no AWS calls |
| `npm run build:web` | Install web deps + build the React app into `web/dist` |
| `npm run deploy` | `build:web` then `cdk deploy` |
| `npm run user -- <add\|list\|revoke>` | Manage users / API keys |
| `npx cdk diff` / `synth` | Preview / synthesize the stack (needs `web/dist` built) |
| `npx cdk destroy` | Tear down (tables are `RETAIN`, so data survives) |
