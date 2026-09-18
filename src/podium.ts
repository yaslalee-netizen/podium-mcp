// Talks to Podium. Gets a fresh pass every time it runs.

export interface Env {
  PODIUM_CLIENT_ID: string;
  PODIUM_CLIENT_SECRET: string;
  PODIUM_REFRESH_TOKEN: string;
  SECRET_PATH: string;
}

// Podium passes expire after 10 hours, so we ask for a new one each time.
// This server runs about once a day, so that costs us nothing.
async function getAccessToken(env: Env): Promise<string> {
  const res = await fetch("https://api.podium.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.PODIUM_CLIENT_ID,
      client_secret: env.PODIUM_CLIENT_SECRET,
      refresh_token: env.PODIUM_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    // Complain loudly and say exactly what to do. A vague error here is
    // how the old Podium job died quietly for three days.
    throw new Error(
      `Podium refresh failed (${res.status}). If this says 400 or 401, the ` +
      `refresh token is dead — redo Part A3 of the guide. Details: ${await res.text()}`
    );
  }

  const data = await res.json<any>();
  return data.access_token;
}

// ── ADDED 18 Sep 2026 ────────────────────────────────────────────────────────
// Short-lived token cache. Some of the new tools make several Podium calls in
// one go (find_contact pages through contacts; lead_response_times reads one
// conversation after another). Without this we'd fetch a brand new access
// token before every single one of those calls, which is slow and pointless.
//
// Podium tokens last 10 hours. We hold one for 30 minutes at most, and any
// 401 forces a fresh one anyway (see podiumRequest below), so a token revoked
// mid-session self-heals on the next call instead of wedging the server.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(env: Env, force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedToken && cachedToken.expiresAt > now) return cachedToken.value;
  const value = await getAccessToken(env);
  cachedToken = { value, expiresAt: now + 30 * 60 * 1000 };
  return value;
}

// Podium replies 202 Accepted with an empty body on some writes (creating a
// contact, for one). Calling res.json() on that throws, which would report a
// successful write as a failure — so parse defensively.
async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return { ok: true, status: res.status };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, status: res.status, raw: text };
  }
}

/**
 * One way in and out of the Podium API, for reads AND writes.
 *
 * Token refresh covers writes exactly as it covers reads: every request goes
 * through getToken, and a 401 triggers one forced refresh and a single retry.
 */
export async function podiumRequest(
  env: Env,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> {
  const send = async (token: string) =>
    fetch(`https://api.podium.com/v4/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let res = await send(await getToken(env));

  // 401 means the token died early (revoked, or the connector was reconnected).
  // Retry once with a forced-fresh token before giving up.
  if (res.status === 401) {
    res = await send(await getToken(env, true));
  }

  if (!res.ok) {
    throw new Error(
      `Podium ${method} "${path}" failed (${res.status}): ${await res.text()}`
    );
  }
  return parseBody(res);
}

// Unchanged behaviour for the four read tools that already existed — this is
// now just a thin GET wrapper over podiumRequest.
export async function podium(env: Env, path: string) {
  return podiumRequest(env, "GET", path);
}
