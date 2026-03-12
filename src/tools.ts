import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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

      const cycleStarts = history.cycles
        .map((c) => (c as { start?: string }).start)
        .filter(Boolean) as string[];
      cycleStarts.sort();
      const earliest = cycleStarts[0]?.split("T")[0] ?? "unknown";
      const latest = cycleStarts[cycleStarts.length - 1]?.split("T")[0] ?? "unknown";
      const spanMonths = Math.round(cycleStarts.length / 30);

      const avg = (vals: number[]) =>
        vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "N/A";

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
  // z.string() compiles fine — no TS2589 (only z.enum() triggers it).
  // Enum constraint is enforced at runtime via VALID_TYPES check below.
  server.registerTool(
    "whoop_history_query",
    {
      title: "Query Whoop History",
      description: "Returns raw historical records filtered by date range and data type. type must be one of: recovery, sleep, cycles, workouts. start and end are optional dates in YYYY-MM-DD format (default: last 90 days). Returns up to 365 records.",
      inputSchema: {
        type: z.string().describe("Data type: recovery | sleep | cycles | workouts"),
        start: z.string().optional().describe("Start date YYYY-MM-DD (default: 90 days ago)"),
        end: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const history = readHistory();
      if (!history) {
        return { content: [{ type: "text" as const, text: "No history data. Run whoop_full_history first." }], isError: true };
      }

      const rawType = params.type;
      if (!VALID_TYPES.includes(rawType as QueryType)) {
        return {
          content: [{ type: "text" as const, text: "Invalid type '" + rawType + "'. Must be one of: recovery, sleep, cycles, workouts" }],
          isError: true,
        };
      }
      const type = rawType as QueryType;

      const endDate = params.end ?? new Date().toISOString().split("T")[0];
      const startDate = params.start ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

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
