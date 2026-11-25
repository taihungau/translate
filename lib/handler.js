import Anthropic from "@anthropic-ai/sdk";
import { translateLines, TranslationRefusedError, DIRECTIONS } from "../translator.js";
import { checkSentence, WritingRefusedError, MAX_WRITING_CHARS } from "./writing.js";
import { handleProgress, hasProgressStore } from "./progress.js";

export { handleProgress };

export const MAX_LINES_PER_REQUEST = 60;

function validate(body) {
  if (!body || !Array.isArray(body.lines)) return "Body must be { lines: [{id, text}], context?: string[], direction?: string }";
  if (body.lines.length === 0 || body.lines.length > MAX_LINES_PER_REQUEST)
    return `lines must contain 1-${MAX_LINES_PER_REQUEST} items`;
  for (const l of body.lines) {
    if (typeof l?.id !== "string" || typeof l?.text !== "string") return "Each line needs string id and text";
  }
  if (body.context !== undefined && (!Array.isArray(body.context) || body.context.some((c) => typeof c !== "string")))
    return "context must be an array of strings";
  if (body.direction !== undefined && !DIRECTIONS.includes(body.direction))
    return `direction must be one of: ${DIRECTIONS.join(", ")}`;
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
    const translations = await translateLines(body.lines, body.context ?? [], { direction: body.direction });
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

const hasClaude = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());

/**
 * The course's writing check: a sentence the learner wrote herself, corrected and explained.
 * @param {unknown} body { text: string, lesson?: string }
 */
export async function handleCheckWriting(body, accessCode) {
  const required = process.env.ACCESS_CODE;
  if (required && accessCode !== required) return { status: 401, body: { error: "Access code required" } };
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_WRITING_CHARS) return { status: 400, body: { error: `text must be 1-${MAX_WRITING_CHARS} characters` } };
  if (body.lesson !== undefined && typeof body.lesson !== "string") return { status: 400, body: { error: "lesson must be a lesson id" } };
  if (!hasClaude()) {
    return { status: 503, body: { error: "ANTHROPIC_API_KEY is not set on the server. Add it on Vercel (Settings → Environment Variables), then redeploy." } };
  }
  try {
    return { status: 200, body: await checkSentence(text, body.lesson) };
  } catch (err) {
    if (err instanceof WritingRefusedError) return { status: 422, body: { error: err.message } };
    if (err instanceof Anthropic.AuthenticationError) return { status: 500, body: { error: "Anthropic credentials are missing or invalid. Set ANTHROPIC_API_KEY." } };
    if (err instanceof Anthropic.RateLimitError) return { status: 429, body: { error: "Rate limited, retry shortly." } };
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error:", err.status, err.message);
      return { status: 502, body: { error: `Writing check service error (${err.status ?? "network"})` } };
    }
    console.error(err);
    return { status: 500, body: { error: `Writing check failed: ${err?.message ?? err}` } };
  }
}

/** Tells the page which speech recognition the server supports (no secrets). */
export function speechConfig() {
  return {
    // The AI teacher: Claude for the lesson, Deepgram to listen and speak.
    teacher: hasClaude() && Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
    cloudSpeech: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
    // The course's play buttons read English aloud with Deepgram's American voices.
    tts: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
    // The course's test checks sentences she writes herself with Claude.
    writing: hasClaude(),
    // Course progress can be saved under a personal code (Upstash Redis connected).
    sync: hasProgressStore(),
    provider: "Deepgram Nova-3",
    // Which Vercel environment answered (production / preview), to help find a missing key.
    environment: process.env.VERCEL_ENV || "local",
  };
}

// Voices for reading the course aloud: Deepgram Aura-2, American English.
export const TTS_VOICES = { female: "aura-2-thalia-en", male: "aura-2-orion-en" };
// The AI teacher's voices: Deepgram Flux TTS, made for conversation, in English and in Russian
// (Aura has no Russian). Her English falls back to the course's Aura voice if Flux fails.
export const TEACHER_VOICES = {
  female: { en: "flux-hannah-en", ru: "flux-natalia-ru" },
  male: { en: "flux-cole-en", ru: "flux-mikhail-ru" },
};
export const TTS_LANGS = ["en", "ru"];
export const MAX_TTS_CHARS = 300;

async function deepgramSpeak(url, key, text) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const why = data.err_msg || data.message || data.error || res.statusText;
      return { status: 502, body: { error: `Deepgram couldn't read this aloud (${res.status}): ${why}` } };
    }
    return { status: 200, audio: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    return { status: 502, body: { error: `Couldn't reach Deepgram: ${err.message}` } };
  }
}

/**
 * Spoken audio (MP3) of a line, for the course's play buttons (American English) and, with
 * `teacher`, for the AI teacher (English or Russian, `lang`). Unlike the phone's built-in voice,
 * an audio file also plays when an iPhone is on silent.
 * @returns {Promise<{status: number, audio?: Buffer, body?: object}>}
 */
export async function handleTts(text, voice = "female", accessCode, { lang = "en", teacher = false } = {}) {
  const required = process.env.ACCESS_CODE;
  if (required && accessCode !== required) return { status: 401, body: { error: "Access code required" } };
  const line = String(text ?? "").trim();
  if (!line || line.length > MAX_TTS_CHARS) return { status: 400, body: { error: `text must be 1-${MAX_TTS_CHARS} characters` } };
  if (!Object.hasOwn(TTS_VOICES, voice)) return { status: 400, body: { error: `voice must be one of: ${Object.keys(TTS_VOICES).join(", ")}` } };
  if (!TTS_LANGS.includes(lang)) return { status: 400, body: { error: `lang must be one of: ${TTS_LANGS.join(", ")}` } };
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) return { status: 503, body: { error: "DEEPGRAM_API_KEY is not set on the server." } };
  const aura = () => deepgramSpeak(`https://api.deepgram.com/v1/speak?model=${TTS_VOICES[voice]}&encoding=mp3`, key, line);
  if (!teacher && lang === "en") return aura();
  const flux = await deepgramSpeak(`https://api.deepgram.com/v2/speak?model=${TEACHER_VOICES[voice][lang]}&encoding=mp3`, key, line);
  if (flux.status !== 200) console.error("Flux TTS failed:", flux.body?.error);
  return flux.status !== 200 && lang === "en" ? aura() : flux;
}

/**
 * A line read aloud plus when each word is said, for the course's talking face: the MP3 (as
 * base64) and its words with start and end times in seconds. Deepgram's voice gives no timings
 * and never says a line exactly the same way twice, so the very clip that is returned is run
 * through Deepgram's speech recognition to time its words. If that fails, `words` is empty and
 * the page estimates them from the audio.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleLipsync(text, voice = "female", accessCode) {
  const spoken = await handleTts(text, voice, accessCode);
  if (spoken.status !== 200) return { status: spoken.status, body: spoken.body };
  let words = [];
  try {
    const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&language=en&punctuate=false&smart_format=false", {
      method: "POST",
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY.trim()}`, "Content-Type": "audio/mpeg" },
      body: spoken.audio,
    });
    const data = res.ok ? await res.json() : null;
    const heard = data?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    const sec = (n) => Math.round(Number(n) * 1000) / 1000;
    words = heard.filter((w) => w?.word && Number.isFinite(w.start) && Number.isFinite(w.end)).map((w) => ({ w: String(w.word), s: sec(w.start), e: sec(w.end) }));
    if (!res.ok) console.error("Deepgram timing failed:", res.status);
  } catch (err) {
    console.error("Deepgram timing failed:", err.message);
  }
  return { status: 200, body: { audio: spoken.audio.toString("base64"), words } };
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
