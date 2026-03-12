import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readHistory, readStatus } from "./store.js";
import { runFullPull } from "./pull.js";

const VALID_TYPES = ["recovery", "sleep", "cycles", "workouts"] as const;
type QueryType = typeof VALID_TYPES[number];

export function registerTools(server: McpServer): void {

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
        return { content: [{ type: "text" as const, text: "Pull already in progress. Use whoop_history_status to check progress." }] };
      }
      runFullPull().catch((err: unknown) => console.error("[tools] Pull error:", err));
      return { content: [{ type: "text" as const, text: "Full history pull started. Runs in background — may take 1-3 minutes.\n\nUse whoop_history_status to check progress." }] };
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
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
        return { content: [{ type: "text" as const, text: "No history data found. Run whoop_full_history first." }], isError: true };
      }

      const cycleStarts = history.cycles.map((c) => (c as { start?: string }).start).filter(Boolean) as string[];
      cycleStarts.sort();
      const earliest = cycleStarts[0]?.split("T")[0] ?? "unknown";
      const latest = cycleStarts[cycleStarts.length - 1]?.split("T")[0] ?? "unknown";
      const spanMonths = Math.round(cycleStarts.length / 30);

      const avg = (arr: number[]) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : "N/A";

      const recoveryScores = history.recoveries
        .map((r) => ((r as { score?: { recovery_score?: number } }).score?.recovery_score))
        .filter((n): n is number => typeof n === "number");

      const hrvValues = history.recoveries
        .map((r) => ((r as { score?: { hrv_rmssd_milli?: number } }).score?.hrv_rmssd_milli))
        .filter((n): n is number => typeof n === "number");

      const sleepScores = history.sleeps
        .map((s) => ((s as { score?: { sleep_performance_percentage?: number } }).score?.sleep_performance_percentage))
        .filter((n): n is number => typeof n === "number");

      const sleepHours = history.sleeps
        .map((s) => {
          const st = (s as { score?: { stage_summary?: { total_in_bed_time_milli?: number; total_awake_time_milli?: number } } }).score?.stage_summary;
          if (!st?.total_in_bed_time_milli) return null;
          return (st.total_in_bed_time_milli - (st.total_awake_time_milli ?? 0)) / 3600000;
        })
        .filter((n): n is number => n !== null);

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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ─── Raw Query ────────────────────────────────────────────────────────────
  // NOTE: Using plain object with 'as any' for inputSchema to work around
  // MCP SDK TS2589 infinite type recursion bug with Zod enums.
  // Parameters are declared so Claude knows they exist, validated at runtime.
  const queryInputSchema = {
    type: { type: "string", enum: ["recovery", "sleep", "cycles", "workouts"], description: "Data type to query: recovery, sleep, cycles, or workouts" },
    start: { type: "string", description: "Start date in YYYY-MM-DD format (optional, default: 90 days ago)" },
    end: { type: "string", description: "End date in YYYY-MM-DD format (optional, default: today)" },
  };

  server.registerTool(
    "whoop_history_query",
    {
      title: "Query Whoop History",
      description: "Returns raw historical records filtered by date range and data type. Required: type (recovery | sleep | cycles | workouts). Optional: start and end as YYYY-MM-DD (default: last 90 days). Returns up to 365 records.",
      inputSchema: queryInputSchema as unknown as Record<string, never>,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: Record<string, unknown>) => {
      const history = readHistory();
      if (!history) {
        return { content: [{ type: "text" as const, text: "No history data. Run whoop_full_history first." }], isError: true };
      }

      const rawType = params["type"];
      if (typeof rawType !== "string" || !VALID_TYPES.includes(rawType as QueryType)) {
        return {
          content: [{ type: "text" as const, text: "Invalid or missing type. Must be one of: recovery, sleep, cycles, workouts" }],
          isError: true,
        };
      }
      const type = rawType as QueryType;

      const endDate = typeof params["end"] === "string"
        ? params["end"]
        : new Date().toISOString().split("T")[0];

      const startDate = typeof params["start"] === "string"
        ? params["start"]
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const recordMap: Record<QueryType, Record<string, unknown>[]> = {
        recovery: history.recoveries,
        sleep: history.sleeps,
        cycles: history.cycles,
        workouts: history.workouts,
      };

      const records = recordMap[type].filter((r) => {
        const dateStr = ((r as { start?: string }).start ?? (r as { created_at?: string }).created_at ?? "");
        const date = dateStr.split("T")[0];
        return date >= startDate && date <= endDate;
      }).slice(0, 365);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ type, start: startDate, end: endDate, count: records.length, records }, null, 2),
        }],
      };
    }
  );
}
