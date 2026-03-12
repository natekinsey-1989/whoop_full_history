import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAuthRoutes } from "./auth.js";
import { registerTools } from "./tools.js";

const mcpServer = new McpServer({
  name: "whoop-history-server",
  version: "1.0.0",
});

registerTools(mcpServer);

const app = express();
app.use(express.json());

registerAuthRoutes(app);

// Inject Accept header before MCP transport sees it, so Claude's connector
// is not rejected for missing text/event-stream in Accept header.
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
  res.json({ service: "whoop-history-server", status: "running" });
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`[server] whoop-history-server running on port ${PORT}`);
  console.log(`[server] MCP endpoint: http://localhost:${PORT}/mcp`);
  if (!process.env.WHOOP_REFRESH_TOKEN) {
    console.log("[server] No tokens. Visit /auth to authorize.");
  }
});
