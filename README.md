# food-tracker-mcp

A remote MCP server for a personal food/calorie database. Deployed with AWS
CDK onto Lambda + DynamoDB, both of which stay in AWS's "Always Free" tier
at personal-use scale.

Exposes two tools to any MCP client (e.g. Claude's orchestrator model):

- **add_food_item** — store a food's name + calories/macros
- **find_food_item** — look up a previously stored food by name (exact or partial)

## Architecture

```
Claude (orchestrator) --HTTPS--> Lambda Function URL --> Lambda (Express + MCP SDK) --> DynamoDB
```

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

`cdk deploy` prints a `McpServerUrl` output — that's the exact URL to give
Claude. It already has your secret baked into the path, e.g.:

```
https://abc123xyz.lambda-url.us-east-1.on.aws/mcp/6f1a9c...
```

⚠️ Treat that URL like a password — anyone who has it can read/write your
food database. Don't commit `.env` or paste the full URL somewhere public.
(This shared-secret-in-path approach is a pragmatic choice for a personal,
single-user tool — see "Security notes" below.)

## Connect it to Claude

1. In Claude, go to **Settings → Connectors → Add custom connector**.
2. Paste the full `McpServerUrl` from the `cdk deploy` output.
3. Save. Enable the connector for a conversation via the "+" button →
   Connectors.

Now your orchestrator model can call `add_food_item` and `find_food_item`
directly.

## Smoke-testing the deployment

Before wiring it into Claude, you can sanity-check the endpoint directly:

```bash
curl -s -X POST "<your McpServerUrl>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
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
1. Copy the new `McpServerUrl` from the output.
2. Update (or re-add) the custom connector in Claude with the new URL.

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

- The API key lives in the URL path rather than a header because, as of
  this writing, Claude's custom-connector UI only accepts a server URL —
  it doesn't yet expose a field for a static bearer token/API key (only
  OAuth client ID/secret). Baking the secret into the path is the practical
  workaround for a personal project.
- If you want real per-user auth (e.g. sharing this with other people),
  you'd want to implement OAuth 2.1 on the Lambda instead — see the [MCP
  authorization spec](https://modelcontextprotocol.io/specification) and
  Claude's [remote MCP docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
  Out of scope for this single-user setup.

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
