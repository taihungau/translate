// Saves course progress under a personal code in Upstash Redis (connected on Vercel under
// Storage), through Upstash's REST API: no driver, just HTTPS.
import { randomInt } from "node:crypto";
import { mergeProgress, normalizeCode, CODE_ALPHABET } from "../public/learn-sync.js";

const TTL_SECONDS = 2 * 365 * 24 * 60 * 60; // kept two years after the last save
export const MAX_PROGRESS_BYTES = 400 * 1024;

// Vercel's Upstash integration names the variables <PREFIX>_REST_API_URL and _TOKEN, with the
// prefix chosen when connecting (KV by default); Upstash's own are UPSTASH_REDIS_REST_URL and _TOKEN.
function store() {
  const env = process.env;
  const pairs = [["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]];
  for (const name of Object.keys(env).sort()) {
    if (name.endsWith("_REST_API_URL")) pairs.push([name, name.replace(/_URL$/, "_TOKEN")]);
  }
  for (const [urlName, tokenName] of pairs) {
    const url = env[urlName]?.trim();
    const token = env[tokenName]?.trim();
    if (url && token && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(url)) return { url: url.replace(/\/+$/, ""), token };
  }
  return null;
}
export const hasProgressStore = () => Boolean(store());

async function redis(db, command) {
  const res = await fetch(db.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${db.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Upstash ${res.status}: ${data.error ?? res.statusText}`);
  return data.result;
}

/** A new code: 4 characters from an alphabet without look-alikes (no 0/O, 1/I/L). */
export function newCode(pick = randomInt) {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return s;
}

const record = (data) => JSON.stringify({ v: 1, data, updatedAt: Date.now() });
function parse(stored) {
  try { return JSON.parse(stored) ?? {}; } catch { return {}; } // unreadable: start from the device's copy
}

// Stores progress under a code nobody has (NX never overwrites one), or null after many clashes.
async function createCode(db, data) {
  for (let tries = 0; tries < 20; tries++) {
    const code = newCode();
    if ((await redis(db, ["SET", `progress:${code}`, record(data), "EX", String(TTL_SECONDS), "NX"])) === "OK") return code;
  }
  return null;
}

/**
 * POST /api/progress
 * - { data } — a device's first save: makes a new code, stores the progress, returns { code, data }.
 * - { code, data } — merges the device's progress into what is stored under the code and returns
 *   the result; 404 when nothing is stored under it.
 *   An old 12-character code is moved to a new short one, returned as `code`; the old one keeps
 *   pointing there, so every phone that still has it ends up on the short code too.
 */
export async function handleProgress(body, accessCode) {
  const required = process.env.ACCESS_CODE;
  if (required && accessCode !== required) return { status: 401, body: { error: "Access code required" } };
  const db = store();
  if (!db) {
    return { status: 503, body: { error: "Progress storage is not set up: connect an Upstash Redis database to the project on Vercel (Storage), then redeploy." } };
  }
  if (!body || typeof body !== "object" || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return { status: 400, body: { error: "Body must be { code?: string, data: object }" } };
  }
  if (JSON.stringify(body.data).length > MAX_PROGRESS_BYTES) return { status: 413, body: { error: "Progress is too large" } };
  const incoming = mergeProgress({}, body.data); // keeps only well-formed progress
  try {
    if (body.code === undefined || body.code === null || body.code === "") {
      const code = await createCode(db, incoming);
      return code ? { status: 201, body: { code, data: incoming } } : { status: 500, body: { error: "Could not make a new code, try again." } };
    }
    const asked = normalizeCode(body.code);
    if (!asked) return { status: 400, body: { error: "code must be 4 letters or digits" } };

    let code = asked;
    let saved = await redis(db, ["GET", `progress:${code}`]);
    if (saved == null) return { status: 404, body: { error: "Nothing is saved under this code" } };
    let entry = parse(saved);
    if (entry.movedTo) { // an old long code: its progress is under a short one now
      const target = normalizeCode(entry.movedTo);
      saved = target ? await redis(db, ["GET", `progress:${target}`]) : null;
      if (saved != null) { code = target; entry = parse(saved); } else entry = {};
    }
    const data = mergeProgress(entry.data ?? {}, incoming);
    if (code.length > 4) {
      const short = await createCode(db, data);
      if (short) {
        await redis(db, ["SET", `progress:${code}`, JSON.stringify({ v: 1, movedTo: short, updatedAt: Date.now() }), "EX", String(TTL_SECONDS)]);
        return { status: 200, body: { code: short, data } };
      }
    }
    await redis(db, ["SET", `progress:${code}`, record(data), "EX", String(TTL_SECONDS)]);
    return { status: 200, body: { code, data } };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: "Progress storage is unavailable, try again shortly." } };
  }
}
