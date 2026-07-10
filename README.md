# food-tracker-mcp

A remote MCP server for a personal food/calorie database. Deployed with AWS
CDK onto Lambda + DynamoDB, both of which stay in AWS's "Always Free" tier
at personal-use scale.

Exposes three tools to any MCP client:

- **add_food_item** — store a food's name + calories/macros (with optional aliases)
- **add_alias** — add an alternative name to an existing food
- **find_food_item** — look up a previously stored food by name or alias (exact or partial)

## Architecture

```
Joey MCP Client (orchestrator)
  ├─ OpenRouter (LLM: GPT, Claude, Gemini, …)
  └─ HTTPS ──> Lambda Function URL ──> Lambda (Express + MCP SDK) ──> DynamoDB
```

[Joey MCP Client](https://play.google.com/store/apps/details?id=com.kaiserapps.joey)
connects to [OpenRouter](https://openrouter.ai/) for the language model and to
this Lambda endpoint for your food-database tools. Joey runs the agentic loop:
the model decides when to call `add_food_item` / `find_food_item`, Joey executes
the tool on your server, and feeds the result back to the model.

Claude's custom-connector UI also works (see below) if you prefer that client.

- **DynamoDB**: single table `food-tracker-items`, partition key `itemLower`,
  provisioned at 5 RCU / 5 WCU (well inside the 25/25 free allowance).
- **Lambda**: Node.js 24 on arm64/Graviton2, runs an Express app wrapping
  the MCP TypeScript SDK's `StreamableHTTPServerTransport` in stateless
  mode. Graviton2 gives faster, cheaper cold starts than x86_64 with zero
  compatibility risk here since there are no native/compiled dependencies.
- **Function URL** (not API Gateway): free, and avoids API Gateway's
  response buffering.

## Folder structure

```
food-tracker-mcp/
├── bin/iac.ts                    CDK app entry point
├── lib/food-tracker-stack.ts     CDK stack: table, Lambda, Function URL
├── lambda/mcp-server/
│   ├── index.ts                  HTTP handler (Express + MCP transport)
│   ├── mcp.ts                    Tool definitions (add_food_item, find_food_item)
│   └── db.ts                     DynamoDB read/write helpers
├── package.json
├── tsconfig.json
├── cdk.json
└── .env.example
```

## Prerequisites

- Node.js 20+
- An AWS account with credentials configured locally (`aws configure`)
- `npx` (ships with npm)

## Setup

```bash
npm install

cp .env.example .env
# then edit .env and set MCP_API_KEY to a random secret, e.g.:
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

# first time only, per AWS account/region:
npx cdk bootstrap

npx cdk deploy
```

`cdk deploy` prints three outputs for wiring up clients:

| Output | Use with |
|--------|----------|
| `McpServerUrlForJoey` | Joey MCP Client → server URL |
| `McpServerAuthHeader` | Joey MCP Client → auth header |
| `McpServerUrl` | Claude custom connector (secret in path) |

Example Joey values:

```
URL:     https://abc123xyz.lambda-url.us-east-1.on.aws/mcp
Headers: Authorization: Bearer 6f1a9c...
```

⚠️ Treat the API key like a password — anyone who has it can read/write your
food database. Don't commit `.env` or paste the key somewhere public.

## Connect it to Joey + OpenRouter

1. Install [Joey MCP Client](https://play.google.com/store/apps/details?id=com.kaiserapps.joey)
   on your phone.
2. In Joey → **Settings**, connect your [OpenRouter](https://openrouter.ai/)
   account (OAuth — no API key to manage in the app).
3. In Joey → **Settings → Manage MCP Servers**, tap **+** and add:
   - **Name**: `food-tracker` (or anything you like)
   - **URL**: the `McpServerUrlForJoey` value from `cdk deploy`
   - **Headers**: paste the `McpServerAuthHeader` value on its own line:
     ```
     Authorization: Bearer <your MCP_API_KEY>
     ```
4. Start a new chat, pick an OpenRouter model (e.g. `anthropic/claude-sonnet-4`,
   `openai/gpt-4o`), and enable the food-tracker MCP server for that chat.

Now you can say things like *"add cheese sticks, 50 cal, 6g protein"* or
*"I ate one cheese stick — how many calories was that?"* and the model will
call your Lambda tools automatically.

## Connect it to Claude (alternative)

1. In Claude, go to **Settings → Connectors → Add custom connector**.
2. Paste the full `McpServerUrl` from the `cdk deploy` output (includes the
   secret in the path).
3. Save. Enable the connector for a conversation via the "+" button →
   Connectors.

Now your orchestrator model can call `add_food_item`, `add_alias`, and
`find_food_item` directly.

## Smoke-testing the deployment

Before wiring it into Joey or Claude, you can sanity-check the endpoint directly:

```bash
# Header auth (Joey style)
curl -s -X POST "<your McpServerUrlForJoey>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <your MCP_API_KEY>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-test","version":"0.0.1"}}}'
```

A JSON-RPC response with `result.serverInfo.name: "food-tracker"` means
it's wired up correctly.

## ⚠️ If you're redeploying after an architecture/runtime change

Changing a Lambda's `Architecture` (e.g. x86_64 → arm64) forces
CloudFormation to **replace** the function rather than update it in place.
Since the Function URL's hostname is derived from the function's identity,
**replacing the function changes the URL** — the old one stops working.

After running `cdk deploy` for such a change:
1. Copy the new outputs from the deploy log.
2. Update the MCP server in Joey (or re-add the custom connector in Claude).

This is a one-time gotcha for this specific kind of change — ordinary code
or config updates don't replace the function or change the URL.

## Cost

Lambda and DynamoDB are both in AWS's permanent "Always Free" tier (not the
12-month-only tier), so a single-user food log realistically costs **$0/month
indefinitely**. Set a AWS Budgets billing alarm as a safety net anyway —
free tier limits still apply, and AWS bills automatically past them with no
built-in warning. Avoid adding a VPC/NAT Gateway to this stack; that's the
most common source of surprise charges, and this project doesn't need one.

## Security notes

- Auth accepts either a `Authorization: Bearer <key>` header (Joey and most
  MCP clients) or the key embedded in the URL path (Claude custom connector,
  which doesn't expose a header field).
- If you want real per-user auth (e.g. sharing this with other people),
  you'd want to implement OAuth 2.1 on the Lambda instead — see the [MCP
  authorization spec](https://modelcontextprotocol.io/specification) and
  Joey's support for OAuth MCP servers. Out of scope for this single-user
  setup.

## Known issue to watch

`@modelcontextprotocol/sdk` is pinned to `1.24.2` in `package.json`
(not a `^` range) because versions `1.25.0+` have a reported regression
with Lambda Function URLs (see [typescript-sdk#1417](https://github.com/modelcontextprotocol/typescript-sdk/issues/1417)).
Check that issue before bumping the SDK version.

## Useful commands

- `npx cdk diff` — see what would change before deploying
- `npx cdk deploy` — deploy/update the stack
- `npx cdk destroy` — tear everything down (the DynamoDB table has
  `RemovalPolicy.RETAIN`, so your food data survives even this)
