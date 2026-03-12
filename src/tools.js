// @ts-nocheck
// Plain JS to avoid MCP SDK TS2589 Zod bug.
// whoop_history_query is registered via low-level server.server.setRequestHandler
// to bypass registerTool's Zod schema validation entirely.

import { readHistory, readStatus } from "./store.js";
import { runFullPull } from "./pull.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VALID_TYPES = ["recovery", "sleep", "cycles", "workouts"];

export function registerTools(server) {

  // ─── Full History Pull ────────────────────────────────────────────────────
  server.registerTool(
    "whoop_full_history",
    {
      title: "Pull Full Whoop History",
      description: "Triggers a one-time bulk pull of ALL historical Whoop data: every cycle, recovery, sleep, and workout record since you first got your Whoop. Paginates automatically. Takes 1-3 minutes. Runs in background — call whoop_history_status to check progress, then whoop_history_summary once complete.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      const status = readStatus();
      if (status.inProgress) {
        return { content: [{ type: "text", text: "Pull already in progress. Use whoop_history_status to check progress." }] };
      }
      runFullPull().catch((err) => console.error("[tools] Pull error:", err));
      return { content: [{ type: "text", text: "Full history pull started. Runs in background — may take 1-3 minutes.\n\nUse whoop_history_status to check progress." }] };
    }
  );

  // ─── Status ───────────────────────────────────────────────────────────────
  server.registerTool(
    "whoop_history_status",
    {
      title: "Check History Pull Status",
      description: "Check the status of an in-progress or completed full history pull. Shows record counts per endpoint and whether the pull is still running.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const status = readStatus();
      const lines = [
        "WHOOP HISTORY PULL STATUS",
        "=========================",
        "In Progress:  " + (status.inProgress ? "yes" : "no"),
        "Started:      " + (status.startedAt ?? "never"),
        "Completed:    " + (status.completedAt ?? "not yet"),
        "Error:        " + (status.error ?? "none"),
        "",
        "RECORDS PULLED",
        "  Cycles:     " + status.counts.cycles,
        "  Recoveries: " + status.counts.recoveries,
        "  Sleeps:     " + status.counts.sleeps,
        "  Workouts:   " + status.counts.workouts,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── Summary ──────────────────────────────────────────────────────────────
  server.registerTool(
    "whoop_history_summary",
    {
      title: "Whoop History Summary",
      description: "Returns a high-level summary of the full historical dataset: date range, record counts, and lifetime averages (avg HRV, avg recovery score, avg sleep hours, avg sleep performance). Run after whoop_full_history completes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const history = readHistory();
      if (!history) {
        return { content: [{ type: "text", text: "No history data found. Run whoop_full_history first." }], isError: true };
      }

      const cycleStarts = history.cycles.map((c) => c.start).filter(Boolean);
      cycleStarts.sort();
      const earliest = (cycleStarts[0] ?? "unknown").split("T")[0];
      const latest = (cycleStarts[cycleStarts.length - 1] ?? "unknown").split("T")[0];
      const spanMonths = Math.round(cycleStarts.length / 30);

      const avg = (vals) =>
        vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "N/A";

      const recoveryScores = history.recoveries.map((r) => r?.score?.recovery_score).filter((n) => typeof n === "number");
      const hrvValues = history.recoveries.map((r) => r?.score?.hrv_rmssd_milli).filter((n) => typeof n === "number");
      const sleepScores = history.sleeps.map((s) => s?.score?.sleep_performance_percentage).filter((n) => typeof n === "number");
      const sleepHours = history.sleeps.map((s) => {
        const st = s?.score?.stage_summary;
        if (!st?.total_in_bed_time_milli) return null;
        return (st.total_in_bed_time_milli - (st.total_awake_time_milli ?? 0)) / 3600000;
      }).filter((n) => n !== null);

      const lines = [
        "WHOOP FULL HISTORY SUMMARY",
        "==========================",
        "Pulled At:    " + history.pulledAt.split("T")[0],
        "Date Range:   " + earliest + " to " + latest,
        "Span:         ~" + spanMonths + " months",
        "",
        "RECORD COUNTS",
        "  Cycles:     " + history.cycles.length,
        "  Recoveries: " + history.recoveries.length,
        "  Sleeps:     " + history.sleeps.length,
        "  Workouts:   " + history.workouts.length,
        "",
        "LIFETIME AVERAGES",
        "  Recovery Score:    " + avg(recoveryScores) + "%",
        "  HRV (RMSSD):       " + avg(hrvValues) + " ms",
        "  Sleep Performance: " + avg(sleepScores) + "%",
        "  Sleep Duration:    " + avg(sleepHours) + " hrs",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── Raw Query ────────────────────────────────────────────────────────────
  // Uses low-level server.server handlers to completely bypass registerTool
  // and its Zod schema validation. We intercept ListTools and CallTool
  // requests at the protocol level, handle whoop_history_query ourselves,
  // and forward everything else to the McpServer's built-in handler.

  const innerServer = server.server;

  // Store reference to original handlers so we can chain them
  const originalListTools = innerServer._requestHandlers?.get("tools/list");
  const originalCallTool = innerServer._requestHandlers?.get("tools/call");

  innerServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
    // Get tools already registered via registerTool
    let existingTools = [];
    if (originalListTools) {
      try {
        const result = await originalListTools(request, {});
        existingTools = result?.tools ?? [];
      } catch (e) {
        console.error("[tools] listTools chain error:", e);
      }
    }

    // Append whoop_history_query with full JSON Schema
    existingTools.push({
      name: "whoop_history_query",
      description: "Returns raw historical records filtered by date range and data type. type must be one of: recovery, sleep, cycles, workouts. start and end are optional dates in YYYY-MM-DD format (default: last 90 days). Returns up to 365 records.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["recovery", "sleep", "cycles", "workouts"],
            description: "Data type to query",
          },
          start: {
            type: "string",
            description: "Start date YYYY-MM-DD (default: 90 days ago)",
          },
          end: {
            type: "string",
            description: "End date YYYY-MM-DD (default: today)",
          },
        },
        required: ["type"],
      },
    });

    return { tools: existingTools };
  });

  innerServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    if (name === "whoop_history_query") {
      const history = readHistory();
      if (!history) {
        return { content: [{ type: "text", text: "No history data. Run whoop_full_history first." }], isError: true };
      }

      const rawType = args?.type;
      if (!rawType || !VALID_TYPES.includes(rawType)) {
        return {
          content: [{ type: "text", text: "Invalid type '" + rawType + "'. Must be one of: recovery, sleep, cycles, workouts" }],
          isError: true,
        };
      }

      const endDate = args?.end ?? new Date().toISOString().split("T")[0];
      const startDate = args?.start ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const recordMap = {
        recovery: history.recoveries,
        sleep: history.sleeps,
        cycles: history.cycles,
        workouts: history.workouts,
      };

      const records = recordMap[rawType].filter((r) => {
        const dateStr = r.start ?? r.created_at ?? "";
        const date = dateStr.split("T")[0];
        return date >= startDate && date <= endDate;
      }).slice(0, 365);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ type: rawType, start: startDate, end: endDate, count: records.length, records }, null, 2),
        }],
      };
    }

    // Forward all other tool calls to the original handler
    if (originalCallTool) {
      return originalCallTool(request, extra);
    }

    return { content: [{ type: "text", text: "Tool not found: " + name }], isError: true };
  });
}
