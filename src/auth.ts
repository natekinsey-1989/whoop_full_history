import type { Express } from "express";
import { saveTokens } from "./token.js";
import type { TokenData } from "./types.js";

const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

const SCOPES = [
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
  "read:profile",
  "read:body_measurement",
  "offline",
].join(" ");

export function registerAuthRoutes(app: Express): void {
  app.get("/auth", (_req, res) => {
    const clientId = process.env.WHOOP_CLIENT_ID;
    const redirectUri = process.env.WHOOP_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.status(500).send("WHOOP_CLIENT_ID and WHOOP_REDIRECT_URI must be set");
      return;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      state: Math.random().toString(36).slice(2),
    });

    res.redirect(`${WHOOP_AUTH_URL}?${params.toString()}`);
  });

  app.get("/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) { res.status(400).send("Missing authorization code"); return; }

    const clientId = process.env.WHOOP_CLIENT_ID;
    const clientSecret = process.env.WHOOP_CLIENT_SECRET;
    const redirectUri = process.env.WHOOP_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      res.status(500).send("Missing OAuth environment variables");
      return;
    }

    try {
      const tokenRes = await fetch(WHOOP_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!tokenRes.ok) { res.status(500).send(`Token exchange failed: ${await tokenRes.text()}`); return; }

      const json = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };

      if (!json.refresh_token) {
        res.status(500).send("No refresh token returned. Ensure 'offline' scope is enabled in your Whoop app.");
        return;
      }

      const tokens: TokenData = {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      };

      saveTokens(tokens);

      res.send(`
        <html><body style="font-family:monospace;padding:40px;background:#0a0a0a;color:#00ff88">
          <h2>✅ Authorized</h2>
          <p>Add this to Railway environment variables:</p>
          <pre style="background:#111;padding:20px;border-radius:8px">WHOOP_REFRESH_TOKEN=${json.refresh_token}</pre>
          <p style="color:#aaa">Then use the <strong>whoop_full_history</strong> tool in Claude to start your historical pull.</p>
        </body></html>
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).send(`Error: ${msg}`);
    }
  });

  app.get("/status", (_req, res) => {
    res.json({ status: "ok", authorized: !!process.env.WHOOP_REFRESH_TOKEN });
  });
}
