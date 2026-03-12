import { getValidAccessToken } from "./token.js";

const BASE = "https://api.prod.whoop.com/developer/v2";

interface PagedResponse<T> {
  records: T[];
  next_token: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getWithRetry<T>(path: string, attempt = 0): Promise<T> {
  const token = await getValidAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  // Rate limited — back off exponentially and retry
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    const waitMs = Math.max(retryAfter * 1000, 1000) * Math.pow(2, attempt);
    const waitSec = Math.round(waitMs / 1000);
    console.log(`[whoop] 429 rate limit on ${path}, waiting ${waitSec}s (attempt ${attempt + 1})`);
    await sleep(waitMs);
    if (attempt < 5) return getWithRetry<T>(path, attempt + 1);
    throw new Error(`Rate limit exceeded after 5 retries on ${path}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whoop API ${res.status} on ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchAllPages<T>(
  endpoint: string,
  onPage?: (count: number) => void
): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | null = null;
  let page = 0;

  do {
    const params = new URLSearchParams({ limit: "25" });
    if (nextToken) params.set("nextToken", nextToken);

    const data = await getWithRetry<PagedResponse<T>>(`${endpoint}?${params.toString()}`);
    all.push(...data.records);
    nextToken = data.next_token;
    page++;

    if (onPage) onPage(all.length);

    // Polite delay between pages to avoid triggering rate limits
    if (nextToken) await sleep(500);
  } while (nextToken);

  console.log(`[whoop] ${endpoint}: fetched ${all.length} records in ${page} pages`);
  return all;
}

export async function fetchProfile(): Promise<Record<string, unknown>> {
  return getWithRetry<Record<string, unknown>>("/user/profile/basic");
}

export async function fetchBody(): Promise<Record<string, unknown>> {
  return getWithRetry<Record<string, unknown>>("/user/measurement/body");
}
