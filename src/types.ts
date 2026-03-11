export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface PullStatus {
  inProgress: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  counts: {
    cycles: number;
    recoveries: number;
    sleeps: number;
    workouts: number;
  };
}

export interface HistoryStore {
  pulledAt: string;
  profile: Record<string, unknown> | null;
  body: Record<string, unknown> | null;
  cycles: Record<string, unknown>[];
  recoveries: Record<string, unknown>[];
  sleeps: Record<string, unknown>[];
  workouts: Record<string, unknown>[];
}
