import { getValidAccessToken } from "./token.js";

const BASE = "https://api.prod.whoop.com/developer/v2";

interface PagedResponse<T> {
  records: T[];
  next_token: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HTTP with retry ──────────────────────────────────────────────────────────

async function getWithRetry<T>(path: string, attempt = 0): Promise<T> {
  const token = await getValidAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    const waitMs = Math.max(retryAfter * 1000, 1000) * Math.pow(2, attempt);
    console.log(`[whoop] 429 rate limit on ${path}, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
    await sleep(waitMs);
    if (attempt < 5) return getWithRetry<T>(path, attempt + 1);
    throw new Error(`Rate limit exceeded after 5 retries on ${path}`);
  }

  if (!res.ok) {
    throw new Error(`Whoop API ${res.status} on ${path}: ${await res.text()}`);
  }

  return res.json() as Promise<T>;
}

// ─── Paginated fetch ──────────────────────────────────────────────────────────
// start/end are YYYY-MM-DD strings. When provided they are passed to the
// Whoop API as start and end query params so only the requested window is
// fetched — avoiding a full history scan for small incremental syncs.

export async function fetchAllPages<T>(
  endpoint: string,
  opts: { start?: string; end?: string; onPage?: (count: number) => void } = {}
): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | null = null;
  let page = 0;

  do {
    const params = new URLSearchParams({ limit: "25" });
    if (nextToken)  params.set("nextToken", nextToken);
    // Whoop API accepts start/end as ISO datetime strings
    if (opts.start) params.set("start", `${opts.start}T00:00:00.000Z`);
    if (opts.end)   params.set("end",   `${opts.end}T23:59:59.999Z`);

    const data = await getWithRetry<PagedResponse<T>>(`${endpoint}?${params.toString()}`);
    all.push(...data.records);
    nextToken = data.next_token;
    page++;

    if (opts.onPage) opts.onPage(all.length);
    if (nextToken) await sleep(500); // polite delay between pages
  } while (nextToken);

  console.log(`[whoop] ${endpoint}: fetched ${all.length} records in ${page} pages`);
  return all;
}

// ─── Profile / body ───────────────────────────────────────────────────────────

export async function fetchProfile(): Promise<Record<string, unknown>> {
  return getWithRetry<Record<string, unknown>>("/user/profile/basic");
}

export async function fetchBody(): Promise<Record<string, unknown>> {
  return getWithRetry<Record<string, unknown>>("/user/measurement/body");
}
