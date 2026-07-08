import express, { Request, Response, NextFunction } from "express";
import serverlessHttp from "serverless-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp";

const API_KEY = process.env.MCP_API_KEY;

const app = express();
app.use(express.json());

// The shared secret lives in the URL path (see lib/food-tracker-stack.ts)
// because Claude's custom-connector UI only takes a URL, not headers.
function checkAuth(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY || req.params.token !== API_KEY) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

// Stateless mode: a fresh McpServer + transport per request. Nothing needs
// to survive between Lambda invocations, which suits Lambda's execution
// model (any invocation can land on a different container).
app.post("/mcp/:token", checkAuth, async (req: Request, res: Response) => {
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
});

// This server doesn't keep sessions open, so there's no server-initiated
// SSE stream to open on GET.
app.get("/mcp/:token", checkAuth, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this server is stateless" },
    id: null,
  });
});

export const handler = serverlessHttp(app);
