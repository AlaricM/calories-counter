/**
 * Local dev only. Runs the REAL chat Lambda handler (lambda/chat/index.ts) as a
 * plain Node HTTP server so the web app can stream against it end-to-end on your
 * machine. It provides a tiny shim for the `awslambda` streaming globals that AWS
 * injects in production, and points DynamoDB at LocalStack. OpenAI is still called
 * for real (there's no local model) — set OPENAI_API_KEY in .env, or chat requests
 * will surface an error just like an un-keyed production deploy.
 *
 *   npm run dev:up && npm run dev:seed   # once
 *   npm run dev:api                      # this server (:8787)
 *   npm run dev:web                      # the React app (:5173)
 *
 * Then open the app, click ⚙︎ Settings, and set:
 *   Backend URL: http://localhost:8787     API key: dev-key
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// --- env: talk to LocalStack, use the stack's table names. Set BEFORE the handler
//     (and its DynamoDB clients) are imported below. ---
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
process.env.AWS_REGION ??= "us-east-1";
process.env.AWS_DEFAULT_REGION ??= process.env.AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.TABLE_NAME ??= "food-tracker-items";
process.env.DAILY_TABLE_NAME ??= "food-tracker-daily";
process.env.USERS_TABLE_NAME ??= "food-tracker-users";

// --- shim the awslambda streaming globals so the handler runs unmodified. In
//     production these are provided by the Lambda runtime; here they map straight
//     onto the Node HTTP response. ---
(globalThis as any).awslambda = {
  streamifyResponse: (fn: unknown) => fn,
  HttpResponseStream: {
    from(res: ServerResponse, meta: { statusCode?: number; headers?: Record<string, string> }) {
      res.writeHead(meta.statusCode ?? 200, meta.headers ?? {});
      return res;
    },
  },
};

// Dynamic import so the env + shim above are in place before the module (and its
// top-level `awslambda.streamifyResponse(...)`) evaluates.
const { handler } = (await import("../lambda/chat/index")) as {
  handler: (event: unknown, responseStream: ServerResponse) => Promise<void>;
};

const PORT = Number(process.env.DEV_API_PORT ?? 8787);

createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const event = {
      requestContext: { http: { method: req.method ?? "POST" } },
      headers: req.headers, // Node lowercases header names; the handler looks them up case-insensitively
      body: body || undefined,
      isBase64Encoded: false,
    };
    try {
      await handler(event, res);
    } catch (err) {
      console.error("dev-server error", err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "dev server error" }));
    }
  });
}).listen(PORT, () => {
  console.log(`Local chat backend → http://localhost:${PORT}`);
  console.log(`  DynamoDB endpoint: ${process.env.AWS_ENDPOINT_URL}`);
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn("  ⚠  OPENAI_API_KEY is not set (.env) — chat will error until you add it.");
  }
});
