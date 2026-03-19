import { writeFileSync, readFileSync, existsSync } from "fs";
import type { TokenData } from "./types.js";

const TOKEN_FILE = "/data/whoop_tokens.json";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

// ─── Refresh mutex ────────────────────────────────────────────────────────────
// Whoop uses rotating refresh tokens — only the first concurrent refresh
// succeeds; all others get 400 because the token was already invalidated.
// One Promise is stored while a refresh is in flight; all concurrent callers
// await the same Promise and share the result.

let refreshInFlight: Promise<TokenData> | null = null;

// ─── Persistence ─────────────────────────────────────────────────────────────

export function saveTokens(data: TokenData): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(data), "utf8");
  console.log("[token] Tokens saved to disk");
}

export function loadTokens(): TokenData | null {
  if (existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as TokenData;
      if (data.refreshToken) return data;
    } catch { /* fall through */ }
  }

  const envRefresh = process.env.WHOOP_REFRESH_TOKEN;
  const envAccess  = process.env.WHOOP_ACCESS_TOKEN;
  if (envRefresh) {
    return {
      accessToken: envAccess ?? "",
      refreshToken: envRefresh,
      expiresAt: envAccess ? Date.now() + 3600 * 1000 : 0,
    };
  }

  return null;
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const clientId     = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET must be set");
  }

  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }

  const json = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: TokenData = {
    accessToken:  json.access_token,
    refreshToken: json.refresh_token,
    expiresAt:    Date.now() + json.expires_in * 1000,
  };

  saveTokens(tokens);
  await updateRailwayRefreshToken(tokens.refreshToken);
  return tokens;
}

// ─── Get valid access token (with mutex) ──────────────────────────────────────

export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("No tokens. Visit /auth to authorize.");

  // Still valid
  if (tokens.expiresAt >= Date.now() + 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  // Serialize concurrent refreshes via mutex
  if (!refreshInFlight) {
    console.log("[token] Access token expired, refreshing...");
    refreshInFlight = refreshAccessToken(tokens.refreshToken).finally(() => {
      refreshInFlight = null;
    });
  } else {
    console.log("[token] Refresh already in flight, waiting...");
  }

  tokens = await refreshInFlight;
  return tokens.accessToken;
}

// ─── Persist new refresh token to Railway env var ────────────────────────────

async function updateRailwayRefreshToken(newRefreshToken: string): Promise<void> {
  const railwayToken   = process.env.RAILWAY_TOKEN;
  const serviceId      = process.env.RAILWAY_SERVICE_ID;
  const environmentId  = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!railwayToken || !serviceId || !environmentId) {
    console.warn("[token] Railway vars not set — skipping refresh token persistence");
    return;
  }

  try {
    const res = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${railwayToken}`,
      },
      body: JSON.stringify({
        query: `mutation UpdateVariable($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        variables: {
          input: { serviceId, environmentId, name: "WHOOP_REFRESH_TOKEN", value: newRefreshToken },
        },
      }),
    });
    if (!res.ok) {
      console.warn(`[token] Railway update failed: ${res.status}`);
    } else {
      console.log("[token] Updated WHOOP_REFRESH_TOKEN in Railway");
    }
  } catch (err) {
    console.warn("[token] Railway update error:", err);
  }
}
