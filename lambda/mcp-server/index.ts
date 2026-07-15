import express, { Request, Response, NextFunction } from "express";
import serverlessHttp from "serverless-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp";
import { resolveUser } from "./users";

const app = express();
app.use(express.json());

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  // Fallback: secret embedded in the URL path (Claude custom connector, which
  // exposes no header field). The /mcp/:token route puts it in req.params.token.
  const token = req.params.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

// Resolve the caller's API key to a user and stash the userId for the handler.
// One key = one user; every tool call is scoped to res.locals.userId, so users
// can never read or write each other's food data.
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = extractApiKey(req);
  if (!key) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const user = await resolveUser(key);
    if (!user) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.locals.userId = user.userId;
    next();
  } catch (err) {
    console.error("auth error", err);
    res.status(500).json({ error: "auth failure" });
  }
}

// Stateless mode: a fresh McpServer + transport per request, bound to the
// authenticated user. Nothing needs to survive between Lambda invocations.
async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const userId = res.locals.userId as string;
  const server = buildServer(userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

function handleMcpGet(_req: Request, res: Response): void {
  // This server doesn't keep sessions open, so there's no server-initiated
  // SSE stream to open on GET.
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this server is stateless" },
    id: null,
  });
}

app.post("/mcp", authenticate, handleMcpPost);
app.get("/mcp", authenticate, handleMcpGet);
app.post("/mcp/:token", authenticate, handleMcpPost);
app.get("/mcp/:token", authenticate, handleMcpGet);

export const handler = serverlessHttp(app);
