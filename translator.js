import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.TRANSLATE_MODEL || "claude-opus-5-5";
// Subtitles are short and latency matters, so default to low effort.
const EFFORT = process.env.TRANSLATE_EFFORT || "low";

const SYSTEM_PROMPT = `You are a professional subtitle translator. You translate English movie and TV subtitles into natural, idiomatic Russian.

Guidelines:
- Write Russian that sounds like real spoken dialogue, not a literal word-for-word rendering.
- Keep each translation about as short as the original: viewers read subtitles while the scene plays.
- Preserve line breaks inside a subtitle (\\n) when the source has them; never merge separate subtitles.
- Keep character names, places and brands as they are normally written in Russian (transliterate when there is no established form).
- Choose "ты" or "вы" from the tone of the conversation and stay consistent with the surrounding lines.
- Keep the speaker's register: slang stays slang, formal speech stays formal, swearing stays roughly as strong.
- Keep sound tags such as [door slams] or (laughs) as tags, translated into Russian.
- Lines may come from live speech recognition and contain recognition errors or missing punctuation; translate the most plausible intended meaning.
- Never add notes, explanations or alternatives. Return a translation for every id you are given.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          ru: { type: "string" },
        },
        required: ["id", "ru"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

export class TranslationRefusedError extends Error {}

let client;
function getClient() {
  // Created lazily so the server can start (and tests can run) without credentials.
  client ??= new Anthropic();
  return client;
}

const cache = new Map();
const CACHE_LIMIT = 5000;

function remember(text, ru) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(text, ru);
}

export function buildUserMessage(lines, context = []) {
  const parts = [];
  if (context.length) {
    parts.push(
      "Earlier dialogue, for context only (do not translate):",
      context.map((c) => `> ${c}`).join("\n"),
      "",
    );
  }
  parts.push(
    "Translate each subtitle below into Russian. Input is JSON:",
    JSON.stringify(lines.map(({ id, text }) => ({ id, en: text }))),
  );
  return parts.join("\n");
}

/**
 * Translate subtitle lines from English to Russian.
 * @param {{id: string, text: string}[]} lines
 * @param {string[]} context preceding English lines, used only for context
 * @returns {Promise<{id: string, text: string}[]>}
 */
export async function translateLines(lines, context = [], { anthropic = getClient() } = {}) {
  const results = new Map();
  const pending = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) results.set(line.id, "");
    else if (cache.has(text)) results.set(line.id, cache.get(text));
    else pending.push({ id: line.id, text });
  }

  if (pending.length) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(pending, context.slice(-8)) }],
    });

    if (response.stop_reason === "refusal") {
      throw new TranslationRefusedError(
        response.stop_details?.explanation || "The model declined to translate these lines.",
      );
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error(`No text in response (stop_reason: ${response.stop_reason})`);
    const parsed = JSON.parse(textBlock.text);
    const byId = new Map(parsed.translations.map((t) => [String(t.id), t.ru]));

    for (const { id, text } of pending) {
      const ru = byId.get(String(id));
      if (ru === undefined) continue; // left missing; client may retry
      results.set(id, ru);
      remember(text, ru);
    }
  }

  return lines
    .filter((l) => results.has(l.id))
    .map((l) => ({ id: l.id, text: results.get(l.id) }));
}
