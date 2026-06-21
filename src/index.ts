import express from "express";
import cron from "node-cron";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAuthRoutes } from "./auth.js";
import { registerTools } from "./tools.js";
import { refreshCache } from "./cache.js";
import { loadTokens } from "./token.js";

// ─── MCP Server ───────────────────────────────────────────────────────────────

const mcpServer = new McpServer({
  name: "whoop-mcp-server",
  version: "1.0.0",
});

registerTools(mcpServer);

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS — required for Claude's connector preflight check to succeed.
// Without these headers, OPTIONS returns 200 but Claude's client treats
// the missing Access-Control-Allow-* headers as an unreachable server.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, mcp-session-id, Mcp-Session-Id"
  );
  res.header("Access-Control-Expose-Headers", "mcp-session-id, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Auth routes: /auth  /callback  /status
registerAuthRoutes(app);

// MCP endpoint (stateless streamable HTTP — one transport per request)
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Health check
app.get("/", (_req, res) => {
  res.json({ service: "whoop-mcp-server", status: "running" });
});

// ─── Daily Cron: 6:00am ET (11:00 UTC) ───────────────────────────────────────

cron.schedule("0 11 * * *", async () => {
  console.log("[cron] Daily sync starting...");
  try {
    await refreshCache();
    console.log("[cron] Daily sync complete");
  } catch (err) {
    console.error("[cron] Daily sync failed:", err);
  }
}, {
  timezone: "America/New_York",
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.listen(PORT, async () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] MCP endpoint: http://localhost:${PORT}/mcp`);

  // On startup: if we have tokens, do an initial cache warm
  const tokens = loadTokens();
  if (tokens?.refreshToken) {
    console.log("[server] Tokens found — warming cache on startup...");
    try {
      await refreshCache();
      console.log("[server] Startup cache warm complete");
    } catch (err) {
      console.warn("[server] Startup cache warm failed (will retry at 6am):", err);
    }
  } else {
    console.log("[server] No tokens found. Visit /auth to authorize.");
  }
});
