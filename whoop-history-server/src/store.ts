import { writeFileSync, readFileSync, existsSync } from "fs";
import type { HistoryStore, PullStatus } from "./types.js";

const HISTORY_FILE = "/tmp/whoop_history.json";
const STATUS_FILE = "/tmp/whoop_pull_status.json";

// ─── History ──────────────────────────────────────────────────────────────────

export function readHistory(): HistoryStore | null {
  if (!existsSync(HISTORY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as HistoryStore;
  } catch {
    return null;
  }
}

export function writeHistory(data: HistoryStore): void {
  writeFileSync(HISTORY_FILE, JSON.stringify(data), "utf8");
  console.log("[store] History written:", data.cycles.length, "cycles,", data.sleeps.length, "sleeps,", data.workouts.length, "workouts");
}

// ─── Pull Status ─────────────────────────────────────────────────────────────

export function readStatus(): PullStatus {
  if (!existsSync(STATUS_FILE)) return defaultStatus();
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf8")) as PullStatus;
  } catch {
    return defaultStatus();
  }
}

export function writeStatus(status: PullStatus): void {
  writeFileSync(STATUS_FILE, JSON.stringify(status), "utf8");
}

function defaultStatus(): PullStatus {
  return {
    inProgress: false,
    startedAt: null,
    completedAt: null,
    error: null,
    counts: { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
  };
}
