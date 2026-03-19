// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

// ─── Coverage metadata ────────────────────────────────────────────────────────
// Tracks min/max date and last sync time per data type.
// Written alongside the history cache so smart-merge can skip already-cached ranges.

export interface CoverageEntry {
  min: string;       // YYYY-MM-DD — earliest record date in cache
  max: string;       // YYYY-MM-DD — latest record date in cache
  updatedAt: string; // ISO timestamp — when this type was last synced
}

export interface CoverageMap {
  cycles:      CoverageEntry;
  recoveries:  CoverageEntry;
  sleeps:      CoverageEntry;
  workouts:    CoverageEntry;
}

// ─── Pull status ──────────────────────────────────────────────────────────────

export interface PullStatus {
  inProgress:   boolean;
  startedAt:    string | null;
  completedAt:  string | null;
  error:        string | null;
  mode:         "full" | "incremental"; // NEW — surfaced in status tool
  requestedStart: string | null;        // NEW — what range was requested
  requestedEnd:   string | null;
  counts: {
    cycles:     number;
    recoveries: number;
    sleeps:     number;
    workouts:   number;
  };
  fetched: {   // NEW — records actually fetched from API (vs already cached)
    cycles:     number;
    recoveries: number;
    sleeps:     number;
    workouts:   number;
  };
}

// ─── History store ────────────────────────────────────────────────────────────

export interface HistoryStore {
  pulledAt:    string; // ISO timestamp of last write
  coverage?:   CoverageMap; // NEW — per-type date coverage
  profile:     Record<string, unknown> | null;
  body:        Record<string, unknown> | null;
  cycles:      Record<string, unknown>[];
  recoveries:  Record<string, unknown>[];
  sleeps:      Record<string, unknown>[];
  workouts:    Record<string, unknown>[];
}

// ─── Whoop API types (from V2, fully typed) ───────────────────────────────────

export interface WhoopCycleScore {
  strain: number | null;
  kilojoule: number | null;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
}

export interface WhoopCycle {
  id: number;
  start: string;
  end: string | null;
  score_state: string;
  score: WhoopCycleScore | null;
}

export interface WhoopRecoveryScore {
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage: number;
  skin_temp_celsius: number;
  user_calibrating: boolean;
}

export interface WhoopRecovery {
  cycle_id: number;
  sleep_id: string;
  created_at: string;
  updated_at: string;
  score_state: string;
  score: WhoopRecoveryScore | null;
}

export interface WhoopSleepStageSummary {
  total_in_bed_time_milli: number;
  total_awake_time_milli: number;
  total_no_data_time_milli: number;
  total_light_sleep_time_milli: number;
  total_slow_wave_sleep_time_milli: number;
  total_rem_sleep_time_milli: number;
  sleep_cycle_count: number;
  disturbance_count: number;
}

export interface WhoopSleepScore {
  stage_summary: WhoopSleepStageSummary;
  respiratory_rate: number;
  sleep_performance_percentage: number;
  sleep_consistency_percentage: number;
  sleep_efficiency_percentage: number;
}

export interface WhoopSleep {
  id: string;
  cycle_id: number;
  start: string;
  end: string;
  nap: boolean;
  score_state: string;
  score: WhoopSleepScore | null;
}

export interface WhoopWorkoutScore {
  strain: number;
  average_heart_rate: number;
  max_heart_rate: number;
  min_heart_rate: number | null;
  kilojoule: number;
  percent_recorded: number;
  distance_meter: number | null;
  altitude_gain_meter: number | null;
  zone_duration: {
    zone_zero_milli:  number | null;
    zone_one_milli:   number | null;
    zone_two_milli:   number | null;
    zone_three_milli: number | null;
    zone_four_milli:  number | null;
    zone_five_milli:  number | null;
  };
}

export interface WhoopWorkout {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_id: number;
  score_state: string;
  score: WhoopWorkoutScore | null;
}

export interface WhoopListResponse<T> {
  records: T[];
  next_token: string | null;
}
