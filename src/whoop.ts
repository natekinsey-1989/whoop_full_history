import { getValidAccessToken } from "./token.js";

const BASE = "https://api.prod.whoop.com/developer/v2";

async function get<T>(path: string): Promise<T> {
  const token = await getValidAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Whoop API ${res.status} on ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface PagedResponse<T> {
  records: T[];
  next_token: string | null;
}

// Fetches ALL records for a given endpoint by paginating until next_token is null.
// onPage callback fires after each page so callers can track progress.
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

    const data = await get<PagedResponse<T>>(`${endpoint}?${params.toString()}`);
    all.push(...data.records);
    nextToken = data.next_token;
    page++;

    if (onPage) onPage(all.length);

    // Small delay between pages to be respectful of rate limits
    if (nextToken) await sleep(300);
  } while (nextToken);

  console.log(`[whoop] ${endpoint}: fetched ${all.length} records in ${page} pages`);
  return all;
}

export async function fetchProfile(): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>("/user/profile/basic");
}

export async function fetchBody(): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>("/user/measurement/body");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
