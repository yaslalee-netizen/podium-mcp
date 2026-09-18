// ── ADDED 18 Sep 2026 ────────────────────────────────────────────────────────
// Two-phase confirmation for anything that reaches a real customer.
//
// Why this exists: these tools text and email actual people, and one of the
// callers is an unattended scheduled job. A single tool call must never be
// able to send. So every customer-facing tool works in two steps:
//
//   1. Called WITHOUT confirmToken -> it sends nothing. It returns a preview
//      of exactly what would go out, plus a one-time token.
//   2. Called WITH that token -> it sends, once.
//
// The token is tied to a fingerprint of the exact payload. Change so much as a
// character of the message body between step 1 and step 2 and the token is
// refused, so the text a human approved is the text that actually goes.
//
// Tokens live in memory in the Durable Object. If the object is evicted
// between the two calls the token vanishes and the send is refused — it fails
// closed, which is the right way round to fail.

interface Staged {
  kind: string;
  fingerprint: string;
  expiresAt: number;
}

const staged = new Map<string, Staged>();
const TTL_MS = 15 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [token, entry] of staged) {
    if (entry.expiresAt <= now) staged.delete(token);
  }
}

// Stable fingerprint of the payload: same content -> same string, regardless
// of the order the keys happened to arrive in.
export function fingerprint(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return JSON.stringify(keys.map((k) => [k, payload[k] ?? null]));
}

export function stage(kind: string, payload: Record<string, unknown>): string {
  sweep();
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  staged.set(token, { kind, fingerprint: fingerprint(payload), expiresAt: Date.now() + TTL_MS });
  return token;
}

// Throws unless the token is live, unused, of the right kind, and was issued
// for this exact payload. Consumes it either way it succeeds — single use.
export function consume(token: string, kind: string, payload: Record<string, unknown>): void {
  sweep();
  const entry = staged.get(token);
  if (!entry) {
    throw new Error(
      "That confirmation token is not valid (wrong, already used, or older than 15 minutes). " +
      "Nothing was sent. Call this tool again WITHOUT confirmToken to get a fresh preview, " +
      "show it to the human, and use the new token."
    );
  }
  staged.delete(token);
  if (entry.kind !== kind) {
    throw new Error(`That confirmation token was issued for "${entry.kind}", not "${kind}". Nothing was sent.`);
  }
  if (entry.fingerprint !== fingerprint(payload)) {
    throw new Error(
      "The message has changed since it was previewed, so the token no longer matches. " +
      "Nothing was sent. Preview the new wording and get it approved before sending."
    );
  }
}

// The block of text every customer-facing tool returns on its first call.
export function previewText(
  action: string,
  fields: Record<string, string>,
  token: string,
  notes: string[] = []
): string {
  const lines = [
    `NOTHING HAS BEEN SENT YET. This is a preview of ${action}.`,
    "",
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
  ];
  if (notes.length) lines.push("", ...notes.map((n) => `Note: ${n}`));
  lines.push(
    "",
    "This goes to a real customer. Show the wording above to the human and wait for them",
    "to say yes. Do not call this tool again until they have. When they approve, call it",
    "again with exactly the same arguments plus:",
    "",
    `  confirmToken: "${token}"`,
    "",
    "The token is single use, expires in 15 minutes, and stops working if the wording changes."
  );
  return lines.join("\n");
}
