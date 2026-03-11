import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readHistory, readStatus } from "./store.js";
import { runFullPull } from "./pull.js";

export function registerTools(server: McpServer): void {

  // ─── Full History Pull ────────────────────────────────────────────────────
  server.registerTool(
    "whoop_full_history",
    {
      title: "Pull Full Whoop History",
      description: `Triggers a one-time bulk pull of ALL historical Whoop data: every cycle, recovery, sleep, and workout record since you first got your Whoop.

Paginates through the entire dataset automatically. For 1-2 years of data this takes 1-3 minutes. The pull runs in the background — call whoop_history_status to check progress, then whoop_history_summary once complete.

Only needs to be run once. After that, use whoop_history_summary or whoop_history_query for analysis.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      const status = readStatus();

      if (status.inProgress) {
        return {
          content: [{ type: "text", text: "Pull already in progress. Use whoop_history_status to check progress." }],
        };
      }

      // Fire and forget — runs in background
      runFullPull().catch(err => console.error("[tools] Pull error:", err));

      return {
        content: [{ type: "text", text: "Full history pull started. This runs in the background and may take 1-3 minutes depending on how much data you have.\n\nUse whoop_history_status to check progress." }],
      };
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

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: status,
      };
    }
  );

  // ─── Summary ──────────────────────────────────────────────────────────────
  server.registerTool(
    "whoop_history_summary",
    {
      title: "Whoop History Summary",
      description: `Returns a high-level summary of the full historical dataset: date range, record counts, and aggregate stats (avg HRV, avg recovery score, avg sleep, total workouts).

Use this after whoop_full_history completes to confirm data quality and get lifetime averages.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const history = readHistory();
      if (!history) {
        return {
          content: [{ type: "text", text: "No history data found. Run whoop_full_history first." }],
          isError: true,
        };
      }

      // Date range
      const cycleStarts = history.cycles
        .map((c) => (c as { start?: string }).start)
        .filter(Boolean) as string[];
      cycleStarts.sort();
      const earliest = cycleStarts[0]?.split("T")[0] ?? "unknown";
      const latest = cycleStarts[cycleStarts.length - 1]?.split("T")[0] ?? "unknown";

      // Avg recovery score
      const recoveryScores = history.recoveries
        .map((r) => ((r as { score?: { recovery_score?: number } }).score?.recovery_score))
        .filter((n): n is number => typeof n === "number");
      const avgRecovery = recoveryScores.length
        ? (recoveryScores.reduce((a, b) => a + b, 0) / recoveryScores.length).toFixed(1)
        : "N/A";

      // Avg HRV
      const hrvValues = history.recoveries
        .map((r) => ((r as { score?: { hrv_rmssd_milli?: number } }).score?.hrv_rmssd_milli))
        .filter((n): n is number => typeof n === "number");
      const avgHRV = hrvValues.length
        ? (hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length).toFixed(1)
        : "N/A";

      // Avg sleep performance
      const sleepScores = history.sleeps
        .map((s) => ((s as { score?: { sleep_performance_percentage?: number } }).score?.sleep_performance_percentage))
        .filter((n): n is number => typeof n === "number");
      const avgSleep = sleepScores.length
        ? (sleepScores.reduce((a, b) => a + b, 0) / sleepScores.length).toFixed(1)
        : "N/A";

      // Avg total sleep hours
      const sleepHours = history.sleeps
        .map((s) => {
          const st = (s as { score?: { stage_summary?: { total_in_bed_time_milli?: number; total_awake_time_milli?: number } } }).score?.stage_summary;
          if (!st?.total_in_bed_time_milli) return null;
          return (st.total_in_bed_time_milli - (st.total_awake_time_milli ?? 0)) / 3600000;
        })
        .filter((n): n is number => n !== null);
      const avgSleepHrs = sleepHours.length
        ? (sleepHours.reduce((a, b) => a + b, 0) / sleepHours.length).toFixed(1)
        : "N/A";

      const lines = [
        "WHOOP FULL HISTORY SUMMARY",
        "==========================",
        "Pulled At:    " + history.pulledAt.split("T")[0],
        "Date Range:   " + earliest + " to " + latest,
        "Span:         ~" + Math.round(cycleStarts.length / 30) + " months",
        "",
        "RECORD COUNTS",
        "  Cycles:     " + history.cycles.length,
        "  Recoveries: " + history.recoveries.length,
        "  Sleeps:     " + history.sleeps.length,
        "  Workouts:   " + history.workouts.length,
        "",
        "LIFETIME AVERAGES",
        "  Recovery Score:   " + avgRecovery + "%",
        "  HRV (RMSSD):      " + avgHRV + " ms",
        "  Sleep Performance:" + avgSleep + "%",
        "  Sleep Duration:   " + avgSleepHrs + " hrs",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          pulledAt: history.pulledAt,
          dateRange: { earliest, latest },
          counts: {
            cycles: history.cycles.length,
            recoveries: history.recoveries.length,
            sleeps: history.sleeps.length,
            workouts: history.workouts.length,
          },
          lifetimeAverages: {
            recovery_score: avgRecovery,
            hrv_ms: avgHRV,
            sleep_performance_pct: avgSleep,
            sleep_hrs: avgSleepHrs,
          },
        },
      };
    }
  );

  // ─── Raw Query ────────────────────────────────────────────────────────────
  server.registerTool(
    "whoop_history_query",
    {
      title: "Query Whoop History",
      description: `Returns raw historical records filtered by date range and data type. Use for deep analysis, trend identification, or feeding data into calculations.

Args:
  - type: "recovery" | "sleep" | "cycles" | "workouts"
  - start: YYYY-MM-DD (optional, defaults to 90 days ago)
  - end: YYYY-MM-DD (optional, defaults to today)

Returns up to 365 records for the specified range and type.`,
      inputSchema: {
        type: {
          enum: ["recovery", "sleep", "cycles", "workouts"],
          description: "Data type to query",
        } as unknown as import("zod").ZodString,
        start: {
          optional: true,
          description: "Start date YYYY-MM-DD (default: 90 days ago)",
        } as unknown as import("zod").ZodString,
        end: {
          optional: true,
          description: "End date YYYY-MM-DD (default: today)",
        } as unknown as import("zod").ZodString,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: Record<string, string>) => {
      const history = readHistory();
      if (!history) {
        return {
          content: [{ type: "text", text: "No history data. Run whoop_full_history first." }],
          isError: true,
        };
      }

      const type = params.type as "recovery" | "sleep" | "cycles" | "workouts";
      const endDate = params.end ?? new Date().toISOString().split("T")[0];
      const startDate = params.start ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const recordMap: Record<string, Record<string, unknown>[]> = {
        recovery: history.recoveries,
        sleep: history.sleeps,
        cycles: history.cycles,
        workouts: history.workouts,
      };

      const records = (recordMap[type] ?? []).filter((r) => {
        const start = ((r as { start?: string; created_at?: string }).start ?? (r as { created_at?: string }).created_at ?? "");
        const date = start.split("T")[0];
        return date >= startDate && date <= endDate;
      }).slice(0, 365);

      return {
        content: [{ type: "text", text: JSON.stringify({ type, start: startDate, end: endDate, count: records.length, records }, null, 2) }],
        structuredContent: { type, start: startDate, end: endDate, count: records.length, records },
      };
    }
  );
}
