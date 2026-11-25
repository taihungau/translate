// The AI teacher's pure logic, kept apart from the page so it can be tested: reading the
// teacher's tagged lines as they stream in, cleaning text for the voices, recognising echo of the
// teacher's own voice in the microphone, and keeping the conversation short enough to send.

/** Tags the teacher writes, one per line (see lib/teacher.js). */
export const TAGS = ["ru", "en", "card", "choices", "fix", "star", "mood", "note", "learned"];
export const MOODS = ["happy", "laugh", "surprised", "thinking", "proud", "kind"];

/**
 * Collects streamed text and hands back complete lines. `push` returns the lines finished by
 * this chunk; `end` returns what is left.
 */
export class LineSplitter {
  constructor() {
    this.rest = "";
  }

  push(chunk) {
    this.rest += chunk;
    const lines = this.rest.split(/\r?\n/);
    this.rest = lines.pop();
    return lines.filter((l) => l.trim());
  }

  end() {
    const last = this.rest.trim();
    this.rest = "";
    return last ? [last] : [];
  }
}

const CYRILLIC = /[Ѐ-ӿ]/g;
const LATIN = /[a-z]/gi;

/** "ru" when a text is mostly Cyrillic, otherwise "en". */
export function languageOf(text) {
  const ru = (String(text).match(CYRILLIC) ?? []).length;
  const en = (String(text).match(LATIN) ?? []).length;
  return ru > en ? "ru" : "en";
}

/** Text for a voice: no markdown, emoji or stray symbols, single spaces. */
export function speakable(text) {
  return String(text ?? "")
    .replace(/[*_`#~^|<>[\]{}\\]/g, " ")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One line from the teacher, as something the page can act on, or null when it is not one of
 * the known tags. A spoken line whose language doesn't match its tag (Russian written after
 * "en:") is still read by the right voice.
 */
export function parseLine(line) {
  const m = /^\s*([a-z]+)\s*:\s*(.*)$/i.exec(String(line));
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const value = m[2].trim();
  if (!TAGS.includes(tag) || !value) return null;
  switch (tag) {
    case "ru":
    case "en": {
      const text = speakable(value);
      if (!text) return null;
      return { type: "say", lang: languageOf(text), text };
    }
    case "card": {
      const [en, ru = ""] = value.split("|").map((s) => s.trim());
      return en ? { type: "card", en, ru } : null;
    }
    case "choices": {
      const options = value.split("|").map((s) => s.trim()).filter(Boolean).slice(0, 4);
      return options.length >= 2 ? { type: "choices", options } : null;
    }
    case "fix": {
      const [wrong, right] = value.split(/\s*(?:→|->|=>)\s*/);
      return right ? { type: "fix", wrong: wrong.trim(), right: right.trim() } : { type: "fix", wrong: "", right: value };
    }
    case "mood": {
      const mood = value.toLowerCase().split(/[^a-z]/)[0];
      return MOODS.includes(mood) ? { type: "mood", mood } : null;
    }
    default:
      return { type: tag, text: value };
  }
}

/**
 * Lines longer than a voice takes in one go are cut at sentence ends (or, failing that, at a
 * comma or a space).
 */
export function splitForVoice(text, max = 280) {
  const parts = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("… "));
    const at = cut > max / 3 ? cut + 1 : Math.max(window.lastIndexOf(", ") + 1, window.lastIndexOf(" "));
    const end = at > 0 ? at : max;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const wordsOf = (text) => String(text).toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * Is what the microphone heard just the teacher's own voice coming back from the speaker? True
 * when nearly all of its words are among the words the teacher has just said.
 */
export function isEcho(heard, said) {
  const h = wordsOf(heard);
  if (!h.length) return true;
  const s = new Set(wordsOf(said));
  if (!s.size) return false;
  const found = h.filter((w) => s.has(w)).length;
  return found / h.length >= (h.length <= 2 ? 1 : 0.7);
}

/**
 * The conversation to send: the latest `max` messages, starting with one of hers, alternating.
 * Two of her turns in a row (the teacher's answer was dropped) become one.
 */
export function conversation(messages, max = 40) {
  const merged = [];
  for (const m of messages) {
    if (!m?.content?.trim()) continue;
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  let out = merged.slice(-max);
  while (out.length && out[0].role !== "user") out = out.slice(1);
  return out.map((m) => ({ ...m, content: m.content.slice(-2000) }));
}

/** What she said, as the teacher receives it: how it came, then the words. */
export const herTurn = (how, text = "") => `[${how}]${text ? ` ${String(text).trim()}` : ""}`;

/** Notes about her, newest last, without repeats, at most `max`. */
export function rememberNote(notes, note, max = 30) {
  const text = String(note ?? "").trim().slice(0, 160);
  if (!text) return notes;
  const key = text.toLowerCase();
  return [...notes.filter((n) => n.toLowerCase() !== key), text].slice(-max);
}
