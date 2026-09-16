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

export async function podium(env: Env, path: string) {
  const token = await getAccessToken(env);
  const res = await fetch(`https://api.podium.com/v4/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Podium request "${path}" failed (${res.status}): ${await res.text()}`);
  return res.json();
}
