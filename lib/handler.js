import Anthropic from "@anthropic-ai/sdk";
import { translateLines, TranslationRefusedError } from "../translator.js";

export const MAX_LINES_PER_REQUEST = 60;

function validate(body) {
  if (!body || !Array.isArray(body.lines)) return "Body must be { lines: [{id, text}], context?: string[] }";
  if (body.lines.length === 0 || body.lines.length > MAX_LINES_PER_REQUEST)
    return `lines must contain 1-${MAX_LINES_PER_REQUEST} items`;
  for (const l of body.lines) {
    if (typeof l?.id !== "string" || typeof l?.text !== "string") return "Each line needs string id and text";
  }
  if (body.context !== undefined && (!Array.isArray(body.context) || body.context.some((c) => typeof c !== "string")))
    return "context must be an array of strings";
  return null;
}

/**
 * Shared by the local server and the Vercel function.
 * @param {unknown} body parsed JSON request body
 * @param {string | undefined} accessCode value of the x-access-code header
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleTranslate(body, accessCode) {
  const required = process.env.ACCESS_CODE;
  if (required && accessCode !== required) return { status: 401, body: { error: "Access code required" } };

  const problem = validate(body);
  if (problem) return { status: 400, body: { error: problem } };

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      status: 500,
      body: {
        error:
          "ANTHROPIC_API_KEY is not set on the server. Add it to the environment (on Vercel: Settings → Environment Variables), then redeploy.",
      },
    };
  }

  try {
    const translations = await translateLines(body.lines, body.context ?? []);
    return { status: 200, body: { translations } };
  } catch (err) {
    if (err instanceof TranslationRefusedError) return { status: 422, body: { error: err.message } };
    if (err instanceof Anthropic.AuthenticationError)
      return { status: 500, body: { error: "Anthropic credentials are missing or invalid. Set ANTHROPIC_API_KEY." } };
    if (err instanceof Anthropic.RateLimitError) return { status: 429, body: { error: "Rate limited, retry shortly." } };
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error:", err.status, err.message);
      return { status: 502, body: { error: `Translation service error (${err.status ?? "network"})` } };
    }
    console.error(err);
    return { status: 500, body: { error: `Translation failed: ${err?.message ?? err}` } };
  }
}

/** Tells the page which speech recognition the server supports (no secrets). */
export function speechConfig() {
  return {
    cloudSpeech: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
    provider: "Deepgram Nova-3",
    // Which Vercel environment answered (production / preview), to help find a missing key.
    environment: process.env.VERCEL_ENV || "local",
  };
}

/**
 * Short-lived Deepgram token for the browser, so the API key never leaves the server.
 * The browser only needs it to open its streaming connection.
 */
export async function handleSpeechToken(accessCode) {
  const required = process.env.ACCESS_CODE;
  if (required && accessCode !== required) return { status: 401, body: { error: "Access code required" } };
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) return { status: 503, body: { error: "DEEPGRAM_API_KEY is not set on the server." } };
  try {
    const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${key}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const why = data.err_msg || data.message || data.error || res.statusText;
      return { status: 502, body: { error: `Deepgram refused the API key (${res.status}): ${why}` } };
    }
    return { status: 200, body: { token: data.access_token, expiresIn: data.expires_in } };
  } catch (err) {
    return { status: 502, body: { error: `Couldn't reach Deepgram: ${err.message}` } };
  }
}
