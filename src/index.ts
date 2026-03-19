import express from "express";
import cron from "node-cron";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAuthRoutes } from "./auth.js";
import { registerTools } from "./tools.js";
import { runDateRangePull } from "./pull.js";
import { loadTokens } from "./token.js";

// ─── MCP Server ───────────────────────────────────────────────────────────────

const mcpServer = new McpServer({
  name: "whoop-history-server",
  version: "1.1.0",
});

registerTools(mcpServer);

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

registerAuthRoutes(app);

// Inject Accept header so Claude's connector isn't rejected for missing text/event-stream
app.post("/mcp", (req, _res, next) => {
  req.headers["accept"] = "application/json, text/event-stream";
  next();
}, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (_req, res) => {
  res.json({ service: "whoop-history-server", version: "1.1.0", status: "running" });
});

// ─── Daily cron: 6:00am ET (11:00 UTC) ───────────────────────────────────────
// Fetches only yesterday → today so it's fast and doesn't re-pull cached history.

cron.schedule("0 11 * * *", async () => {
  console.log("[cron] Daily sync starting...");
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const todayStr  = new Date().toISOString().split("T")[0];
  try {
    await runDateRangePull(yesterday, todayStr);
    console.log("[cron] Daily sync complete");
  } catch (err) {
    console.error("[cron] Daily sync failed:", err);
  }
}, { timezone: "America/New_York" });

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.listen(PORT, async () => {
  console.log(`[server] whoop-history-server v1.1.0 listening on port ${PORT}`);
  console.log(`[server] MCP endpoint: http://localhost:${PORT}/mcp`);

  const tokens = loadTokens();
  if (tokens?.refreshToken) {
    // On cold start, sync the last 2 days to catch anything since last run
    console.log("[server] Tokens found — syncing last 2 days on startup...");
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split("T")[0];
    const todayStr   = new Date().toISOString().split("T")[0];
    try {
      await runDateRangePull(twoDaysAgo, todayStr);
      console.log("[server] Startup sync complete");
    } catch (err) {
      console.warn("[server] Startup sync failed (non-fatal — cache still intact):", err);
    }
  } else {
    console.log("[server] No tokens found. Visit /auth to authorize.");
  }
});
