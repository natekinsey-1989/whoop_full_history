import { fetchAllPages, fetchProfile, fetchBody } from "./whoop.js";
import {
  readHistory, writeHistory, readStatus, writeStatus,
  buildCoverage, computeCoverage,
} from "./store.js";
import type { PullStatus, HistoryStore, CoverageEntry } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function recordId(r: Record<string, unknown>): string {
  // Cycles use id, recoveries use cycle_id, sleeps use id, workouts use id
  return String(r["id"] ?? r["cycle_id"] ?? "");
}

function recordDate(r: Record<string, unknown>): string {
  return ((r["start"] ?? r["created_at"] ?? "") as string).split("T")[0];
}

// Determine what date range to fetch from the Whoop API given what's cached.
// Returns null if the entire requested range is already covered.
function rangeToFetch(
  coverage: CoverageEntry | undefined,
  requestedStart: string,
  requestedEnd: string
): { start: string; end: string } | null {
  if (!coverage || !coverage.min || !coverage.max) {
    // Nothing cached — fetch everything requested
    return { start: requestedStart, end: requestedEnd };
  }

  // Requested range fully inside cached coverage → nothing to fetch
  if (requestedStart >= coverage.min && requestedEnd <= coverage.max) {
    return null;
  }

  // Fetch only the portions outside cached coverage.
  // Simple strategy: fetch from requestedStart up to coverage.min (if earlier)
  // AND from coverage.max up to requestedEnd (if later).
  // We make one contiguous fetch covering the full uncovered span to keep it simple.
  const fetchStart = requestedStart < coverage.min ? requestedStart : coverage.max;
  const fetchEnd   = requestedEnd   > coverage.max ? requestedEnd   : coverage.min;

  if (fetchStart > fetchEnd) return null; // nothing to do
  return { start: fetchStart, end: fetchEnd };
}

// Merge new records into existing, deduplicating by id/cycle_id
function mergeRecords(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[]
): { merged: Record<string, unknown>[]; added: number } {
  const seen = new Set(existing.map(recordId));
  const novel = incoming.filter(r => !seen.has(recordId(r)));
  return {
    merged: [...existing, ...novel],
    added:  novel.length,
  };
}

// ─── Full pull (initial baseline or forced re-pull) ───────────────────────────

export async function runFullPull(): Promise<void> {
  const existing = readStatus();
  if (existing.inProgress) {
    console.log("[pull] Already in progress, skipping");
    return;
  }

  const status: PullStatus = {
    inProgress:     true,
    startedAt:      new Date().toISOString(),
    completedAt:    null,
    error:          null,
    mode:           "full",
    requestedStart: null,
    requestedEnd:   null,
    counts:  { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
    fetched: { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
  };
  writeStatus(status);

  let cycles:     Record<string, unknown>[] = [];
  let recoveries: Record<string, unknown>[] = [];
  let sleeps:     Record<string, unknown>[] = [];
  let workouts:   Record<string, unknown>[] = [];
  let profile:    Record<string, unknown> | null = null;
  let body:       Record<string, unknown> | null = null;

  try {
    console.log("[pull:full] Fetching profile...");
    profile = await fetchProfile().catch(() => null);
    body    = await fetchBody().catch(() => null);

    console.log("[pull:full] Fetching cycles...");
    cycles = await fetchAllPages<Record<string, unknown>>("/cycle", {
      onPage: n => { status.counts.cycles = n; writeStatus(status); },
    });
    status.fetched.cycles = cycles.length;
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });

    console.log("[pull:full] Fetching recoveries...");
    recoveries = await fetchAllPages<Record<string, unknown>>("/recovery", {
      onPage: n => { status.counts.recoveries = n; writeStatus(status); },
    });
    status.fetched.recoveries = recoveries.length;
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });

    console.log("[pull:full] Fetching sleeps...");
    sleeps = await fetchAllPages<Record<string, unknown>>("/activity/sleep", {
      onPage: n => { status.counts.sleeps = n; writeStatus(status); },
    });
    status.fetched.sleeps = sleeps.length;
    writeHistory({ pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts });

    console.log("[pull:full] Fetching workouts...");
    workouts = await fetchAllPages<Record<string, unknown>>("/activity/workout", {
      onPage: n => { status.counts.workouts = n; writeStatus(status); },
    });
    status.fetched.workouts = workouts.length;

    const store: HistoryStore = {
      pulledAt: new Date().toISOString(),
      profile, body, cycles, recoveries, sleeps, workouts,
    };
    store.coverage = buildCoverage(store);
    writeHistory(store);

    status.inProgress   = false;
    status.completedAt  = new Date().toISOString();
    status.counts       = { cycles: cycles.length, recoveries: recoveries.length, sleeps: sleeps.length, workouts: workouts.length };
    writeStatus(status);
    console.log("[pull:full] Complete:", status.counts);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[pull:full] Failed:", msg);
    const partial: HistoryStore = { pulledAt: new Date().toISOString(), profile, body, cycles, recoveries, sleeps, workouts };
    partial.coverage = buildCoverage(partial);
    writeHistory(partial);
    status.inProgress = false;
    status.error = msg;
    status.counts = { cycles: cycles.length, recoveries: recoveries.length, sleeps: sleeps.length, workouts: workouts.length };
    writeStatus(status);
  }
}

// ─── Date-range pull (incremental sync, smart cache merge) ───────────────────
// start/end are YYYY-MM-DD strings.
// - Checks coverage metadata per data type
// - Only fetches from Whoop API what isn't already cached
// - Merges new records into existing cache by id/cycle_id deduplication
// - Updates coverage metadata after merge

export async function runDateRangePull(start: string, end: string): Promise<void> {
  const existing = readStatus();
  if (existing.inProgress) {
    console.log("[pull] Already in progress, skipping");
    return;
  }

  const status: PullStatus = {
    inProgress:     true,
    startedAt:      new Date().toISOString(),
    completedAt:    null,
    error:          null,
    mode:           "incremental",
    requestedStart: start,
    requestedEnd:   end,
    counts:  { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
    fetched: { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 },
  };
  writeStatus(status);

  // Load existing cache (may be null if this is first run — fall back to empty)
  const history = readHistory() ?? {
    pulledAt: new Date().toISOString(),
    profile: null,
    body: null,
    cycles: [],
    recoveries: [],
    sleeps: [],
    workouts: [],
  };

  const cov = history.coverage;

  try {
    // ── Cycles ──
    const cycleRange = rangeToFetch(cov?.cycles, start, end);
    if (cycleRange) {
      console.log(`[pull:incremental] Fetching cycles ${cycleRange.start} → ${cycleRange.end}`);
      const incoming = await fetchAllPages<Record<string, unknown>>("/cycle", {
        start: cycleRange.start, end: cycleRange.end,
        onPage: n => { status.counts.cycles = n; writeStatus(status); },
      });
      const { merged, added } = mergeRecords(history.cycles, incoming);
      history.cycles = merged;
      status.fetched.cycles = added;
      console.log(`[pull:incremental] Cycles: fetched ${incoming.length}, added ${added} new`);
    } else {
      console.log("[pull:incremental] Cycles: fully cached, skipping API call");
    }
    status.counts.cycles = history.cycles.length;

    // ── Recoveries ──
    const recoveryRange = rangeToFetch(cov?.recoveries, start, end);
    if (recoveryRange) {
      console.log(`[pull:incremental] Fetching recoveries ${recoveryRange.start} → ${recoveryRange.end}`);
      const incoming = await fetchAllPages<Record<string, unknown>>("/recovery", {
        start: recoveryRange.start, end: recoveryRange.end,
        onPage: n => { status.counts.recoveries = n; writeStatus(status); },
      });
      const { merged, added } = mergeRecords(history.recoveries, incoming);
      history.recoveries = merged;
      status.fetched.recoveries = added;
      console.log(`[pull:incremental] Recoveries: fetched ${incoming.length}, added ${added} new`);
    } else {
      console.log("[pull:incremental] Recoveries: fully cached, skipping API call");
    }
    status.counts.recoveries = history.recoveries.length;

    // ── Sleeps ──
    const sleepRange = rangeToFetch(cov?.sleeps, start, end);
    if (sleepRange) {
      console.log(`[pull:incremental] Fetching sleeps ${sleepRange.start} → ${sleepRange.end}`);
      const incoming = await fetchAllPages<Record<string, unknown>>("/activity/sleep", {
        start: sleepRange.start, end: sleepRange.end,
        onPage: n => { status.counts.sleeps = n; writeStatus(status); },
      });
      const { merged, added } = mergeRecords(history.sleeps, incoming);
      history.sleeps = merged;
      status.fetched.sleeps = added;
      console.log(`[pull:incremental] Sleeps: fetched ${incoming.length}, added ${added} new`);
    } else {
      console.log("[pull:incremental] Sleeps: fully cached, skipping API call");
    }
    status.counts.sleeps = history.sleeps.length;

    // ── Workouts ──
    const workoutRange = rangeToFetch(cov?.workouts, start, end);
    if (workoutRange) {
      console.log(`[pull:incremental] Fetching workouts ${workoutRange.start} → ${workoutRange.end}`);
      const incoming = await fetchAllPages<Record<string, unknown>>("/activity/workout", {
        start: workoutRange.start, end: workoutRange.end,
        onPage: n => { status.counts.workouts = n; writeStatus(status); },
      });
      const { merged, added } = mergeRecords(history.workouts, incoming);
      history.workouts = merged;
      status.fetched.workouts = added;
      console.log(`[pull:incremental] Workouts: fetched ${incoming.length}, added ${added} new`);
    } else {
      console.log("[pull:incremental] Workouts: fully cached, skipping API call");
    }
    status.counts.workouts = history.workouts.length;

    // ── Write merged cache with updated coverage ──
    history.pulledAt = new Date().toISOString();
    history.coverage = buildCoverage(history);
    writeHistory(history);

    status.inProgress  = false;
    status.completedAt = new Date().toISOString();
    writeStatus(status);
    console.log("[pull:incremental] Complete. Fetched:", status.fetched, "Cache totals:", status.counts);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[pull:incremental] Failed:", msg);
    // Save whatever merged so far
    history.pulledAt = new Date().toISOString();
    history.coverage = buildCoverage(history);
    writeHistory(history);
    status.inProgress = false;
    status.error = msg;
    writeStatus(status);
  }
}
