# food-tracker-mcp

A tiny **remote MCP server** that acts as long-term memory for a calorie/macro
counter. You tell a cheap LLM (through the [Joey MCP client](https://benkaiser.github.io/joey-mcp-client/)
+ [OpenRouter](https://openrouter.ai/)) what you ate; the model saves and recalls
each food's calories and macros from **your own DynamoDB table** — so you don't
have to re-specify "greek yogurt = 160 cal, 17g protein" every single day.

The whole point is to make the *model* dumb and the *memory* reliable: even a
small, inexpensive model can keep an accurate daily food log because the facts
live in the database, not in the prompt.

**Multi-user:** one API key = one user. It's just you today, but you can hand a
friend their own key and their food data is completely separate from yours (each
user lives in their own DynamoDB partition). Add or revoke users anytime with no
redeploy.

Deployed to your personal AWS account with the AWS CDK, running entirely inside
AWS's permanent **"Always Free"** tier (Lambda + DynamoDB), so at personal scale
it costs **~$0/month**.

## Tools exposed to the LLM

| Tool | What it does |
|------|--------------|
| `add_food_item` | Store a food's name + calories/macros (optional aliases, serving size) |
| `add_alias` | Add an alternative name to an existing food |
| `find_food_item` | Look up a saved food by name or alias (exact, then partial match) |
| `add_food_to_daily_count` | Append a known food to today's daily tracker and update cumulative totals |
| `list_daily_entries` | List today's daily tracked food entries and cumulative totals |
| `delete_daily_entry` | Remove a single entry from today's daily tracker without deleting the saved food |
| `delete_food_item` | Delete a saved food item by canonical name |

Typical conversation: *"add cheese sticks, 50 cal, 6g protein, 2.5g fat"* →
`add_food_item`. Later: *"I ate two cheese sticks, how much was that?"* →
`find_food_item` → the model multiplies and answers. When the user says *"I ate an apple today"* the model should use `add_food_to_daily_count`, and when the user wants a summary it should use `list_daily_entries`.

## How it works

```
Joey MCP Client (phone / desktop — runs the agentic loop)
  ├─ OpenRouter  ── the LLM (pick a cheap model: GPT-4o-mini, Gemini Flash, Llama…)
  └─ HTTPS ─────> Lambda Function URL ─> Lambda (Express + MCP SDK) ─> DynamoDB
                        │
                        └─ each request carries a per-user API key → scoped to that user
```

Joey is the orchestrator: the model decides when to call a tool, Joey executes
the call against your Lambda (sending the user's API key), Lambda resolves the
key to a `userId` and runs the tool against *only* that user's data, then the
result flows back to the model. Your Lambda holds no LLM logic and no OpenRouter
key.

- **Lambda** — Node.js 24 on **arm64/Graviton2**, an Express app wrapping the MCP
  TypeScript SDK's `StreamableHTTPServerTransport` in **stateless** mode (a fresh
  server per request — nothing needs to survive between invocations).
- **Function URL** (not API Gateway) — free, and supports the chunked responses
  the MCP transport can use. IAM auth is `NONE` **by design**; access is gated
  per-user by the API key checked inside the Lambda (see [Security](#security)).

### Data model — three DynamoDB tables

**`food-tracker-items`** — composite key isolates each user's foods:

```jsonc
{
  "userId":    "usr_9f2c1a",     // partition key — whose food this is
  "itemLower": "greek yogurt",   // sort key — normalized name (trim + lowercase)
  "item":      "Greek yogurt",   // display name, original casing
  "aliases":   ["160 cal greek yogurt"],  // normalized, de-duplicated
  "calories":  160,
  "proteinG":  17, "fatG": 0, "carbsG": 9,   // all optional
  "serving":   "1 container (170g)"          // optional
}
```

A lookup is a `Query` on the user's partition, so results can *never* include
another user's items — isolation is structural, not a filter that could be
forgotten.

**`food-tracker-daily`** — composite key isolates each user's daily entries:

```jsonc
{
  "userId": "usr_9f2c1a",
  "dayOrder": "2026-07-15#0001",
  "day": "2026-07-15",
  "order": 1,
  "item": "Apple",
  "calories": 95,
  "proteinG": 0,
  "fatG": 0,
  "carbsG": 25,
  "cumulativeCalories": 95,
  "cumulativeProteinG": 0,
  "cumulativeFatG": 0,
  "cumulativeCarbsG": 25,
  "serving": "1 medium"
}
```

The daily tracker stores the order and cumulative totals for each item logged on
that Central Time day. If an item is removed with `delete_daily_entry`, later
entries are renumbered and the remaining cumulative totals are recomputed.

**`food-tracker-users`** — maps an API key to a user:

```jsonc
{
  "apiKeyHash": "b1946ac9…",  // partition key — SHA-256 of the API key
  "userId":     "usr_9f2c1a",
  "name":       "Alaric",
  "createdAt":  "2026-07-15T10:40:00.000Z"
}
```

Only the **hash** of each key is stored, so a database read can't recover anyone's
usable credential. The Lambda has **read-only** access to this table; keys are
minted/revoked by an admin CLI (below) using your deploy credentials.

## Repo layout

```
calories-counter/
├── bin/iac.ts                    CDK app entry point (reads optional .env, builds the stack)
├── lib/food-tracker-stack.ts     CDK stack: 2 DynamoDB tables + Lambda + Function URL + budget
├── lambda/mcp-server/
│   ├── index.ts                  HTTP handler: Express + per-user auth + MCP transport
│   ├── mcp.ts                    MCP tool definitions + system-prompt wiring (bound to a userId)
│   ├── system-prompt.ts          The always-on counter persona (edit your targets here)
│   ├── db.ts                     Food-item read/write helpers (userId-scoped)
│   ├── users.ts                  Resolve an API key → user (reads the users table)
│   └── hash.ts                   SHA-256 of an API key (shared by Lambda + admin CLI)
├── types.ts                      Shared FoodItem / UserRecord / tool I/O types
├── scripts/
│   ├── bootstrap.sh              One-command local setup + deploy + first user (macOS)
│   └── manage-users.ts           Admin CLI: add / list / revoke users
├── .env.example                  Optional config template (cost alerts)
├── cdk.json  package.json  tsconfig.json
└── AGENTS.md                     Orientation for AI coding agents
```

---

# From scratch: zero to running

Steps 1–3 are **manual** (you can't script creating an AWS account or IAM user).
Everything after that is one command: [`scripts/bootstrap.sh`](scripts/bootstrap.sh).

## Step 1 — Create an AWS account (manual)

1. Go to <https://portal.aws.amazon.com/billing/signup> and sign up.
2. Verify email, phone, and add a payment method (required even for free tier).
3. **Immediately secure the root user**: sign in as root → **Security
   credentials** → enable **MFA**. Then stop using root for anything else.

## Step 2 — Create a non-root admin user (manual, IAM hygiene)

Never deploy as the root account. Create a dedicated user instead:

1. Console → **IAM** → **Users** → **Create user** (e.g. `cdk-deployer`).
2. Attach permissions. For a **solo personal account** the pragmatic choice is
   the AWS-managed **`AdministratorAccess`** policy — you own everything in the
   account anyway. (Tighter options in [Security](#security).)
3. Create the user, then open it → **Security credentials** → **Enable MFA**.
4. Same page → **Create access key** → *Command Line Interface (CLI)*. Copy the
   **Access key ID** and **Secret access key** (shown once).

## Step 3 — Point the AWS CLI at that user (manual)

Install the AWS CLI if you don't have it (`brew install awscli`), then:

```bash
aws configure
# AWS Access Key ID:     <paste>
# AWS Secret Access Key: <paste>
# Default region name:   us-east-1     # or your preferred region
# Default output format: json
```

Verify it works — this must print your account ID:

```bash
aws sts get-caller-identity
```

## Step 4 — Everything else, in one command

From the repo root:

```bash
./scripts/bootstrap.sh          # or: npm run setup
```

That script (macOS, idempotent, safe to re-run) will:

- install **Homebrew**, **Node** (>=20; via `nvm` if needed), and the **AWS CLI**
  if any are missing;
- verify your AWS credentials (fails early with instructions if Step 3 isn't done);
- run `npm ci`;
- `cdk bootstrap` (first time per account/region) and `cdk deploy`;
- create your **first user + API key** and print it (skipped if one already exists).

Copy the printed URL + `Authorization: Bearer <key>` — that's what goes into Joey.

### …or do Step 4 manually

```bash
# prerequisites (macOS)
brew install node awscli          # or use nvm to match .nvmrc (Node 24)

# project + deploy
npm ci
npx cdk bootstrap                 # first time per account/region only
npx cdk deploy                    # prints the McpServerUrl output

# create yourself as the first user (prints your key once)
npm run user -- add --name "Your Name" --url "<McpServerUrl from cdk deploy>"
```

> Deploying needs **no secret** — auth is per-user and stored (hashed) in
> DynamoDB. `.env` is optional and only carries cost-alert settings; copy
> `.env.example` to `.env` and set `ALERT_EMAIL` if you want cost emails.

## Step 5 — Managing users (giving a friend a key)

The admin CLI runs locally with your AWS credentials (the Lambda can't mint keys):

```bash
# add a friend — prints their key ONCE, plus ready-to-paste Joey settings
npm run user -- add --name "Jane" --url "<McpServerUrl>"

# see everyone (no secrets shown)
npm run user -- list

# revoke someone (deletes their key; their stored food data is left intact)
npm run user -- revoke --name "Jane"
```

Each `add` mints a brand-new user with its own isolated data. (To give one
person a *second* key that shares their existing data, pass
`--user <their userId>`.)

> ⚠️ An API key is a password to that user's food database. It's shown only once
> on creation — anyone who has it can read/write that user's data.

## Step 6 — Wire up Joey + OpenRouter

1. Install [Joey](https://benkaiser.github.io/joey-mcp-client/) (iOS, Android,
   macOS; Windows/Linux experimental).
2. Create an [OpenRouter](https://openrouter.ai/) account → **Keys** → create an
   API key → paste it into Joey's settings. Pick a **cheap model that supports
   tool calling** — e.g. `openai/gpt-4o-mini`, `google/gemini-flash-1.5`, or
   `meta-llama/llama-3.3-70b-instruct`. (Check the model shows a **Tools**
   capability on <https://openrouter.ai/models> — tool calling is required.)
3. In Joey, add a remote MCP server:
   - **URL**: the `McpServerUrl` value
   - **Headers / auth**: `Authorization: Bearer <your API key>`
4. Start a chat, enable the food-tracker server, and say
   *"add cheese sticks, 50 cal, 6g protein"* — the model will call your Lambda.

### Connect Claude instead (alternative)

Claude's custom-connector UI has no header field, so it uses the secret-in-path
URL: **Settings → Connectors → Add custom connector**, paste
`<McpServerUrl>/<your API key>`, save, then enable it for a conversation.

## Step 7 — Smoke-test the endpoint (optional)

The server is lenient about request headers — any `Accept` (even `*/*` or none)
works, and it replies with plain `application/json`:

```bash
curl -s -X POST "<McpServerUrl>" \
  -H "Authorization: Bearer <your API key>" \
  -H "Content-Type: application/json" \
  -H "Accept: */*" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-test","version":"0.0.1"}}}'
```

A response containing `result.serverInfo.name: "food-tracker"` means it's wired
up. `401` = no key sent; `403` = key not recognized.

---

## Give the LLM a consistent persona

You almost certainly want the model to behave the same way in every chat — *"you
are my calorie counter; macros must sum to calories; if fat runs high, cut carbs
rather than raise the calorie cap,"* and so on. That text lives in one place:
[`lambda/mcp-server/system-prompt.ts`](lambda/mcp-server/system-prompt.ts) —
**edit the "Daily targets" block to your own numbers.**

It reaches the model up to three ways:

1. **Automatic (server `instructions`).** The server advertises the prompt in its
   MCP handshake; clients that honor MCP instructions add it to the system prompt
   for you, so it applies to every conversation with no per-chat setup. Push
   changes with `npx cdk deploy`.
2. **On demand (`counter_context` prompt).** The server also exposes it as an MCP
   *prompt*, for clients that support prompts but don't auto-apply instructions —
   insert it from the client's prompt/slash menu.
3. **Guaranteed (paste into your client).** Whether a given client auto-applies
   (1) isn't guaranteed, so for a hard guarantee also paste the same text into
   Joey's **system-prompt / custom-instructions** field (or an OpenRouter system
   message if you build your own client). Copy it straight from the file above.

> Multi-user note: the server sends the **same** instructions to every API key, so
> keep personal specifics light — each person can set their own daily targets in
> their own client.

## Security

- **Per-user isolation.** Food data is partitioned by `userId`; lookups are a
  `Query` on that partition, so one user physically cannot read another's data.
- **Keys stored hashed.** The users table holds only `SHA-256(key)`. A leak of
  the table doesn't expose usable keys, and keys are shown exactly once at
  creation.
- **Runtime least privilege, per table.** The Lambda role gets `GetItem` /
  `PutItem` / `Query` on the items table and **`GetItem` only** on the users
  table — so a compromised Lambda still can't create or alter keys. Minting keys
  requires your deploy credentials (`npm run user`).
- **Public endpoint + key.** The Function URL is `authType: NONE` because Joey
  can't sign SigV4 requests; access is gated by the per-user API key checked in
  [`lambda/mcp-server/index.ts`](lambda/mcp-server/index.ts) (Bearer header, or
  `/mcp/<key>` path for Claude). **Revoke** anyone with `npm run user -- revoke`.
- **Deploy least privilege (to tighten later).** `AdministratorAccess` on a
  dedicated non-root user with MFA is the pragmatic solo-account choice. To lock
  deploys down further, use a CDK **permissions boundary** and a scoped
  CloudFormation execution policy — see `cdk bootstrap --help`
  (`--cloudformation-execution-policies`, `--custom-permissions-boundary`).
- **Stronger auth?** For real OAuth per user instead of shared bearer keys, see
  the [MCP authorization spec](https://modelcontextprotocol.io/specification);
  Joey supports OAuth MCP servers. The key model here is plenty for you + friends.

## Cost

Lambda and DynamoDB here are in AWS's **permanent** Always-Free tier (not the
12-month-only tier). The free DynamoDB allowance (**25 GB + 25 RCU + 25 WCU**) is
**shared across all tables in the account**, and the two small tables here
provision only 10 RCU / 6 WCU combined — so a personal food log realistically
costs **$0/month indefinitely**. As a safety net, the stack provisions an **AWS
Budgets** cost alarm (default **$1/month**) that emails you if anything ever costs
money — set `ALERT_EMAIL` in `.env`, tune with `MONTHLY_BUDGET_USD`.

Avoid adding a VPC/NAT Gateway — that's the most common source of surprise AWS
charges, and this project doesn't need one.

## Redeploying after an architecture/runtime change ⚠️

Changing the Lambda's `Architecture` (e.g. x86_64 → arm64) forces CloudFormation
to **replace** the function. The Function URL's hostname is derived from the
function's identity, so **replacing the function changes the URL** — the old one
stops working. After such a deploy, copy the new `McpServerUrl` and re-give it to
each user's client. Ordinary code/config updates don't replace the function and
don't change the URL. (The same applies to changing a table's key schema — it
replaces the table; with `RemovalPolicy.RETAIN` you'd need to drop the old one
first. There's no data yet, so it's a non-issue on first deploy.)

## Dependency note

`@modelcontextprotocol/sdk` is on `^1.29.0`. Some earlier `1.25.x` releases had a
reported regression with Lambda Function URLs
([typescript-sdk#1417](https://github.com/modelcontextprotocol/typescript-sdk/issues/1417));
if you bump the SDK and streaming breaks, check that issue and the smoke test above.

## Useful commands

| Command | What it does |
|---------|--------------|
| `npm run setup` | Full from-scratch install + deploy + first user (macOS) |
| `npm run build` | Type-check the whole project (`tsc --noEmit`) — no AWS calls |
| `npm run user -- <add\|list\|revoke>` | Manage users / API keys |
| `npx cdk diff` | Show what a deploy would change |
| `npx cdk synth` | Synthesize the CloudFormation template locally |
| `npx cdk deploy` | Deploy / update the stack |
| `npx cdk destroy` | Tear down (both tables are `RETAIN`, so data survives) |
