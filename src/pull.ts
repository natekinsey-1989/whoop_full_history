import { fetchAllPages, fetchProfile, fetchBody } from "./whoop.js";
import { writeHistory, writeStatus, readStatus } from "./store.js";
import type { PullStatus } from "./types.js";

// Runs the full historical pull sequentially (not parallel) to avoid rate limits.
// Saves incrementally so partial data is never lost on crash.
export async function runFullPull(): Promise<void> {
  const existing = readStatus();
  if (existing.inProgress) {
    console.log("[pull] Already in progress, skipping");
    return;
  }

  const status: PullStatus = {
    inProgress: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    counts: { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
  };
  writeStatus(status);

  // Accumulated data — saved incrementally after each endpoint
  let cycles: Record<string, unknown>[] = [];
  let recoveries: Record<string, unknown>[] = [];
  let sleeps: Record<string, unknown>[] = [];
  let workouts: Record<string, unknown>[] = [];
  let profile: Record<string, unknown> | null = null;
  let body: Record<string, unknown> | null = null;

  try {
    console.log("[pull] Fetching profile...");
    profile = await fetchProfile().catch(() => null);
    body = await fetchBody().catch(() => null);

    // Sequential fetches with incremental saves after each endpoint
    console.log("[pull] Fetching cycles...");
    cycles = await fetchAllPages<Record<string, unknown>>("/cycle", (n) => {
      status.counts.cycles = n;
      writeStatus(status);
    });
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });
    console.log("[pull] Cycles saved:", cycles.length);

    console.log("[pull] Fetching recoveries...");
    recoveries = await fetchAllPages<Record<string, unknown>>("/recovery", (n) => {
      status.counts.recoveries = n;
      writeStatus(status);
    });
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });
    console.log("[pull] Recoveries saved:", recoveries.length);

    console.log("[pull] Fetching sleeps...");
    sleeps = await fetchAllPages<Record<string, unknown>>("/activity/sleep", (n) => {
      status.counts.sleeps = n;
      writeStatus(status);
    });
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });
    console.log("[pull] Sleeps saved:", sleeps.length);

    console.log("[pull] Fetching workouts...");
    workouts = await fetchAllPages<Record<string, unknown>>("/activity/workout", (n) => {
      status.counts.workouts = n;
      writeStatus(status);
    });
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });
    console.log("[pull] Workouts saved:", workouts.length);

    // Mark complete
    status.inProgress = false;
    status.completedAt = new Date().toISOString();
    status.counts = {
      cycles: cycles.length,
      recoveries: recoveries.length,
      sleeps: sleeps.length,
      workouts: workouts.length,
    };
    writeStatus(status);
    console.log("[pull] Complete:", status.counts);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[pull] Failed:", msg);

    // Save whatever we got before the failure
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });

    status.inProgress = false;
    status.error = msg;
    status.counts = {
      cycles: cycles.length,
      recoveries: recoveries.length,
      sleeps: sleeps.length,
      workouts: workouts.length,
    };
    writeStatus(status);
    console.log("[pull] Partial data saved:", status.counts);
  }
}
