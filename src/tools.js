// @ts-nocheck
// Tools registered via a hybrid approach:
// 1. One dummy registerTool call to declare the 'tools' capability to the SDK
// 2. Low-level setRequestHandler overrides to bypass Zod validation entirely
//    and serve our actual tool definitions + handlers

import { readHistory, readStatus } from "./store.js";
import { runFullPull, runDateRangePull } from "./pull.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const VALID_TYPES = ["recovery", "sleep", "cycles", "workouts"];

function isValidDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().split("T")[0];
}

// ─── Real tool definitions (served via low-level handler) ─────────────────────

const TOOLS = [
  {
    name: "whoop_full_history",
    description:
      "Triggers a Whoop data pull and caches results to persistent storage.\n\n" +
      "WITHOUT start/end: full re-pull of all history (1-3 min). Use once for initial baseline or forced refresh.\n\n" +
      "WITH start and/or end (YYYY-MM-DD): incremental pull — only fetches data outside the cached range, " +
      "merges new records into existing cache, and updates coverage metadata. Fast for daily syncs.\n\n" +
      "WITH force=true: bypasses cache check and re-fetches the full requested range from the Whoop API. " +
      "Use this after editing activity tags in the Whoop app to overwrite stale cached records.\n\n" +
      "Examples:\n" +
      "  whoop_full_history()                                             — full re-pull\n" +
      "  whoop_full_history(start='2026-03-18')                           — sync from Mar 18 to today\n" +
      "  whoop_full_history(start='2026-03-18', end='2026-03-19')         — specific range\n" +
      "  whoop_full_history(start='2026-03-18', end='2026-03-19', force=true) — force re-fetch (tag updates)\n\n" +
      "Runs in background. Use whoop_history_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Start date YYYY-MM-DD. Omit for full re-pull." },
        end:   { type: "string", description: "End date YYYY-MM-DD (default: today)." },
        force: { type: "boolean", description: "Bypass cache check and re-fetch from Whoop API. Use after editing activity tags in the app." },
      },
    },
  },
  {
    name: "whoop_history_status",
    description:
      "Check the status of an in-progress or completed history pull. " +
      "Shows mode (full vs incremental), requested date range, records fetched from API, " +
      "and current cache totals per data type.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whoop_history_summary",
    description:
      "High-level summary of the full historical dataset: per-type coverage with last-updated timestamps, " +
      "record counts, and lifetime averages (HRV, recovery score, sleep hours, sleep performance). " +
      "Run after whoop_full_history completes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whoop_history_query",
    description:
      "Returns raw historical records from the local cache filtered by date range and data type. " +
      "No API call — reads from cache only. " +
      "type must be one of: recovery, sleep, cycles, workouts. " +
      "start/end default to last 90 days. Returns up to 365 records.",
    inputSchema: {
      type: "object",
      properties: {
        type:  { type: "string", enum: ["recovery", "sleep", "cycles", "workouts"], description: "Data type to query" },
        start: { type: "string", description: "Start date YYYY-MM-DD (default: 90 days ago)" },
        end:   { type: "string", description: "End date YYYY-MM-DD (default: today)" },
      },
      required: ["type"],
    },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleFullHistory(args) {
  const status = readStatus();
  if (status.inProgress) {
    return { content: [{ type: "text", text: "Pull already in progress. Use whoop_history_status to check progress." }] };
  }

  const start = args && args.start;
  const force = !!(args && args.force);
  const end   = (args && args.end) || today();

  if (start && !isValidDate(start)) {
    return { content: [{ type: "text", text: "Invalid start date '" + start + "'. Use YYYY-MM-DD format." }], isError: true };
  }
  if (args && args.end && !isValidDate(args.end)) {
    return { content: [{ type: "text", text: "Invalid end date '" + args.end + "'. Use YYYY-MM-DD format." }], isError: true };
  }
  if (start && end && start > end) {
    return { content: [{ type: "text", text: "start (" + start + ") must be before or equal to end (" + end + ")." }], isError: true };
  }

  if (start) {
    runDateRangePull(start, end, !!force).catch(function(err) { console.error("[tools] Date-range pull error:", err); });
    return {
      content: [{
        type: "text",
        text: "Incremental pull started for " + start + " -> " + end + ".\n" +
              "Smart cache merge active — only unfetched ranges will hit the Whoop API.\n\n" +
              "Use whoop_history_status to check progress.",
      }],
    };
  }

  runFullPull().catch(function(err) { console.error("[tools] Full pull error:", err); });
  return {
    content: [{
      type: "text",
      text: "Full history pull started. Runs in background — may take 1-3 minutes.\n\nUse whoop_history_status to check progress.",
    }],
  };
}

async function handleStatus() {
  var s = readStatus();
  var lines = [
    "WHOOP HISTORY PULL STATUS",
    "=========================",
    "Mode:         " + (s.mode || "full"),
    "In Progress:  " + (s.inProgress ? "yes" : "no"),
    "Started:      " + (s.startedAt || "never"),
    "Completed:    " + (s.completedAt || "not yet"),
    "Error:        " + (s.error || "none"),
  ];
  if (s.requestedStart) {
    lines.push("Range:        " + s.requestedStart + " -> " + (s.requestedEnd || today()));
  }
  lines.push(
    "",
    "RECORDS FETCHED FROM API",
    "  Cycles:     " + ((s.fetched && s.fetched.cycles) || 0),
    "  Recoveries: " + ((s.fetched && s.fetched.recoveries) || 0),
    "  Sleeps:     " + ((s.fetched && s.fetched.sleeps) || 0),
    "  Workouts:   " + ((s.fetched && s.fetched.workouts) || 0),
    "",
    "CACHE TOTALS",
    "  Cycles:     " + s.counts.cycles,
    "  Recoveries: " + s.counts.recoveries,
    "  Sleeps:     " + s.counts.sleeps,
    "  Workouts:   " + s.counts.workouts
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleSummary() {
  var history = readHistory();
  if (!history) {
    return { content: [{ type: "text", text: "No history data found. Run whoop_full_history first." }], isError: true };
  }

  var cycleStarts = history.cycles.map(function(c) { return c.start; }).filter(Boolean).sort();
  var earliest = (cycleStarts[0] || "unknown").split("T")[0];
  var latest = (cycleStarts[cycleStarts.length - 1] || "unknown").split("T")[0];
  var spanMonths = Math.round(cycleStarts.length / 30);

  function avg(vals) {
    return vals.length ? (vals.reduce(function(a, b) { return a + b; }, 0) / vals.length).toFixed(1) : "N/A";
  }

  var recoveryScores = history.recoveries.map(function(r) { return r && r.score && r.score.recovery_score; }).filter(function(n) { return typeof n === "number"; });
  var hrvValues = history.recoveries.map(function(r) { return r && r.score && r.score.hrv_rmssd_milli; }).filter(function(n) { return typeof n === "number"; });
  var sleepScores = history.sleeps.map(function(s) { return s && s.score && s.score.sleep_performance_percentage; }).filter(function(n) { return typeof n === "number"; });
  var sleepHours = history.sleeps.map(function(s) {
    var st = s && s.score && s.score.stage_summary;
    if (!st || !st.total_in_bed_time_milli) return null;
    return (st.total_in_bed_time_milli - (st.total_awake_time_milli || 0)) / 3600000;
  }).filter(function(n) { return n !== null; });

  var lines = [
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
  ];

  var cov = history.coverage;
  if (cov) {
    lines.push("", "COVERAGE (per data type)");
    Object.keys(cov).forEach(function(type) {
      var entry = cov[type];
      var updated = entry.updatedAt ? "  last synced " + entry.updatedAt.split("T")[0] : "";
      lines.push("  " + (type + "            ").slice(0, 12) + ": " + entry.min + " -> " + entry.max + updated);
    });
  }

  lines.push(
    "",
    "LIFETIME AVERAGES",
    "  Recovery Score:    " + avg(recoveryScores) + "%",
    "  HRV (RMSSD):       " + avg(hrvValues) + " ms",
    "  Sleep Performance: " + avg(sleepScores) + "%",
    "  Sleep Duration:    " + avg(sleepHours) + " hrs"
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleQuery(args) {
  var history = readHistory();
  if (!history) {
    return { content: [{ type: "text", text: "No history data. Run whoop_full_history first." }], isError: true };
  }

  var rawType = args && args.type;
  if (!rawType || !VALID_TYPES.includes(rawType)) {
    return {
      content: [{ type: "text", text: "Invalid type '" + rawType + "'. Must be one of: " + VALID_TYPES.join(", ") }],
      isError: true,
    };
  }

  var endDate = (args && args.end) || today();
  var startDate = (args && args.start) || daysAgo(90);

  var recordMap = {
    recovery: history.recoveries,
    sleep: history.sleeps,
    cycles: history.cycles,
    workouts: history.workouts,
  };

  var records = recordMap[rawType]
    .filter(function(r) {
      var d = (r.start || r.created_at || "").split("T")[0];
      return d >= startDate && d <= endDate;
    })
    .slice(0, 365);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ type: rawType, start: startDate, end: endDate, count: records.length, records: records }, null, 2),
    }],
  };
}

// ─── Register tools ───────────────────────────────────────────────────────────

export function registerTools(server) {
  // Step 1: Register a dummy tool via registerTool to declare the 'tools'
  // capability to the MCP SDK. Without this, setRequestHandler for
  // tools/list throws "Server does not support tools".
  server.registerTool(
    "_cap",
    { title: "cap", description: "internal", inputSchema: {} },
    async function() { return { content: [] }; }
  );

  // Step 2: Override ListTools and CallTool at the protocol level to serve
  // our real tool definitions and bypass Zod schema validation entirely.
  var innerServer = server.server;

  innerServer.setRequestHandler(ListToolsRequestSchema, async function() {
    return { tools: TOOLS };
  });

  innerServer.setRequestHandler(CallToolRequestSchema, async function(request) {
    var name = request.params.name;
    var args = request.params.arguments;

    if (name === "whoop_full_history")    return handleFullHistory(args);
    if (name === "whoop_history_status")  return handleStatus();
    if (name === "whoop_history_summary") return handleSummary();
    if (name === "whoop_history_query")   return handleQuery(args);

    return { content: [{ type: "text", text: "Tool not found: " + name }], isError: true };
  });
}
