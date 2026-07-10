import express, { Request, Response, NextFunction } from "express";
import serverlessHttp from "serverless-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp";

const API_KEY = process.env.MCP_API_KEY;

const app = express();
app.use(express.json());

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  } else return undefined;
}

// Accept the shared secret either as a Bearer token (Joey MCP Client) or
// embedded in the URL path (Claude custom connector).
function checkAuth(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY || extractApiKey(req) !== API_KEY) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

// Stateless mode: a fresh McpServer + transport per request. Nothing needs
// to survive between Lambda invocations, which suits Lambda's execution
// model (any invocation can land on a different container).
async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const server = buildServer();
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

app.post("/mcp", checkAuth, handleMcpPost);
app.get("/mcp", checkAuth, handleMcpGet);
app.post("/mcp/:token", checkAuth, handleMcpPost);
app.get("/mcp/:token", checkAuth, handleMcpGet);

export const handler = serverlessHttp(app);
