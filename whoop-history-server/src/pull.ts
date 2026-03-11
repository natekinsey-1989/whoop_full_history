import { fetchAllPages, fetchProfile, fetchBody } from "./whoop.js";
import { writeHistory, writeStatus, readStatus } from "./store.js";
import type { PullStatus } from "./types.js";

// Runs the full historical pull across all endpoints.
// Designed to be fire-and-forget — status is tracked in STATUS_FILE.
export async function runFullPull(): Promise<void> {
  const status = readStatus();
  if (status.inProgress) {
    console.log("[pull] Already in progress, skipping");
    return;
  }

  const newStatus: PullStatus = {
    inProgress: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    counts: { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
  };
  writeStatus(newStatus);

  try {
    console.log("[pull] Starting full historical pull...");

    const [profile, body] = await Promise.all([
      fetchProfile().catch(() => null),
      fetchBody().catch(() => null),
    ]);

    // Pull all endpoints in parallel — each paginates independently
    const [cycles, recoveries, sleeps, workouts] = await Promise.all([
      fetchAllPages<Record<string, unknown>>("/cycle", (n) => {
        newStatus.counts.cycles = n;
        writeStatus(newStatus);
      }),
      fetchAllPages<Record<string, unknown>>("/recovery", (n) => {
        newStatus.counts.recoveries = n;
        writeStatus(newStatus);
      }),
      fetchAllPages<Record<string, unknown>>("/activity/sleep", (n) => {
        newStatus.counts.sleeps = n;
        writeStatus(newStatus);
      }),
      fetchAllPages<Record<string, unknown>>("/activity/workout", (n) => {
        newStatus.counts.workouts = n;
        writeStatus(newStatus);
      }),
    ]);

    writeHistory({
      pulledAt: new Date().toISOString(),
      profile,
      body,
      cycles,
      recoveries,
      sleeps,
      workouts,
    });

    newStatus.inProgress = false;
    newStatus.completedAt = new Date().toISOString();
    newStatus.counts = {
      cycles: cycles.length,
      recoveries: recoveries.length,
      sleeps: sleeps.length,
      workouts: workouts.length,
    };
    writeStatus(newStatus);

    console.log("[pull] Complete:", newStatus.counts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[pull] Failed:", msg);
    newStatus.inProgress = false;
    newStatus.error = msg;
    writeStatus(newStatus);
  }
}
