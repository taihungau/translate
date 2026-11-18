// The Learn page's logic that doesn't touch the screen: checking what was said or written against
// the phrase, and when a phrase should come back (spaced repetition, like paper flashcards in boxes).

const NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
// Speech recognition writes "25" where the phrase says "twenty-five"; compare as one word.
function spellNumber(digits) {
  const n = Number(digits);
  if (n < 20) return NUMBERS[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? NUMBERS[n % 10] : "");
  return digits;
}
// Speech recognition may write either form; compare them as the same words.
const CONTRACTIONS = {
  "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are", "he's": "he is", "she's": "she is",
  "it's": "it is", "that's": "that is", "what's": "what is", "where's": "where is", "there's": "there is",
  "here's": "here is", "let's": "let us", "i'll": "i will", "you'll": "you will", "we'll": "we will",
  "i'd": "i would", "you'd": "you would", "i've": "i have", "you've": "you have", "we've": "we have",
  "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "can not", "cannot": "can not",
  "won't": "will not", "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
  "couldn't": "could not", "wouldn't": "would not", "shouldn't": "should not",
};
// Words that sound the same, and British/American spellings.
const SAME = { two: "to", too: "to", four: "for", okay: "ok", centre: "center", theatre: "theater", colour: "color", favourite: "favorite" };

function expand(word) {
  const w = word.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9']/g, "").replace(/^'+|'+$/g, "");
  if (!w) return [];
  const spelled = /^\d+$/.test(w) ? spellNumber(w) : w;
  return (CONTRACTIONS[spelled] ?? spelled.replace(/'s$/, "")).split(" ").map((t) => SAME[t] ?? t);
}

/** Comparable words: "I'm fine, thanks!" → ["i", "am", "fine", "thanks"] */
export function tokens(text) {
  return String(text ?? "").split(/\s+/).flatMap(expand);
}

// Longest common subsequence of two word lists: which words of each are matched, in order.
function matchInOrder(want, got) {
  const n = want.length;
  const m = got.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = want[i] === got[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hitWant = new Array(n).fill(false);
  const hitGot = new Array(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (want[i] === got[j]) { hitWant[i] = hitGot[j] = true; i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return { hitWant, hitGot };
}

// The words as written, each with its comparable tokens ("I'm" → ["i", "am"]).
const wordsOf = (text) => String(text ?? "").split(/\s+/).filter(Boolean).map((word) => ({ word, toks: expand(word) }));

// Marks each written word as matched when all of its tokens were.
function markWords(words, hits) {
  let k = 0;
  return words.map(({ word, toks }) => {
    let ok = true;
    for (let t = 0; t < toks.length; t++) ok = hits[k++] && ok;
    return { word, ok };
  });
}

/**
 * How well `heard` (what speech recognition wrote) matches `phrase`: each word of the phrase
 * marked as said or missed, and the share of the phrase's words that were said, in order.
 * @returns {{words: {word: string, ok: boolean}[], score: number}}
 */
export function compareSpeech(phrase, heard) {
  const parts = wordsOf(phrase);
  const want = parts.flatMap((p) => p.toks);
  const { hitWant } = matchInOrder(want, tokens(heard));
  return { words: markWords(parts, hitWant), score: want.length ? hitWant.filter(Boolean).length / want.length : 0 };
}

// One letter added, missing, changed or two swapped: "cofee" for "coffee", "work" for "works".
export function oneLetterOff(a, b) {
  if (a === b || Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one changed
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two swapped
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * Checks a typed answer against the right one, as a teacher marks a written test: case and
 * punctuation don't matter, "I'm" and "I am" are the same, but every word must be there and
 * nothing extra. A word one letter off ("work" for "works") is pointed out with its fix, and it
 * still counts as a mistake: in grammar lessons that letter is often the point.
 * @returns {{correct: boolean, score: number, answer: {word: string, ok: boolean, near?: boolean}[],
 *   typed: {word: string, ok: boolean, near?: boolean}[], fixes: {typed: string, right: string}[]}}
 */
export function checkWriting(answer, typed) {
  const want = wordsOf(answer);
  const got = wordsOf(typed).filter((w) => w.toks.length); // a lone "-" or "?" is not a word
  const a = want.flatMap((w) => w.toks);
  const b = got.flatMap((w) => w.toks);
  const { hitWant, hitGot } = matchInOrder(a, b);
  const answerWords = markWords(want, hitWant);
  const typedWords = markWords(got, hitGot);

  // Pair each missed word with a written word one letter off, keeping the order.
  const fixes = [];
  const plain = (w) => w.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9']/g, "");
  let from = 0;
  for (const right of answerWords) {
    if (right.ok) continue;
    for (let t = from; t < typedWords.length; t++) {
      const wrong = typedWords[t];
      if (wrong.ok || !oneLetterOff(plain(wrong.word), plain(right.word))) continue;
      right.near = wrong.near = true;
      fixes.push({ typed: wrong.word.replace(/[^\p{L}\p{N}'’-]/gu, ""), right: right.word.replace(/[^\p{L}\p{N}'’-]/gu, "") });
      from = t + 1;
      break;
    }
  }

  const hits = hitWant.filter(Boolean).length;
  return {
    correct: a.length > 0 && hits === a.length && hits === b.length,
    score: a.length + b.length ? (2 * hits) / (a.length + b.length) : 0,
    answer: answerWords,
    typed: typedWords,
    fixes,
  };
}

/** Phrases for a written test: the lesson's phrases in a new order, at most `size` of them. */
export function testQuestions(phrases, size = 8, random = Math.random) {
  const pool = phrases.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size);
}

export function verdict(score) {
  if (score >= 0.9) return "Отлично! Так и говорят.";
  if (score >= 0.6) return "Почти! Красным отмечены слова, которые не расслышали.";
  return "Ещё разок: послушайте медленно и повторите.";
}

/** "2026-11-04": a calendar day in the phone's own time zone. */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Days in a row with practice, counting back from today, or from yesterday when today's
 * practice hasn't started yet (the streak isn't lost until the day is over).
 * @param {Record<string, number>} days cards practised per dayKey
 */
export function streak(days, today = new Date()) {
  const d = new Date(today);
  if (!days[dayKey(d)]) d.setDate(d.getDate() - 1);
  let count = 0;
  while (days[dayKey(d)]) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

const DAY = 24 * 60 * 60 * 1000;
/** Days until a phrase comes back, by box. "Знаю" moves it up a box; "Ещё раз" back to the first. */
export const INTERVALS = [0, 1, 3, 7, 14, 30];

/** @param {{box: number, due: number} | undefined} state */
export function grade(state, knew, now = Date.now()) {
  const box = knew ? Math.min((state?.box ?? 0) + 1, INTERVALS.length - 1) : 0;
  return { box, due: now + INTERVALS[box] * DAY };
}

/** Known on two different days or more. */
export const isLearned = (state) => (state?.box ?? 0) >= 2;

/** Seen before and due again. Phrases never seen are new, not due. */
export const isDue = (state, now = Date.now()) => Boolean(state) && state.due <= now;

/**
 * Answers to choose from: the right one and up to `count - 1` others from `pool`, each shown once,
 * in a random order. Used by the listening and reading exercises.
 */
export function choices(right, pool, count = 4, random = Math.random) {
  const others = testQuestions([...new Set(pool)].filter((x) => x !== right), count - 1, random);
  return testQuestions([right, ...others], count, random);
}

// ---------------------------------------------------------------- learning faster
// Words not worth blanking out in a fill-the-gap exercise: they don't test the phrase.
const CLOZE_SKIP = new Set(["the", "and", "you", "are", "for", "was", "his", "her", "its", "our", "but", "not", "can",
  "has", "have", "had", "she", "they", "them", "this", "that", "with", "your", "what", "who", "i'm", "it's", "i'd",
  "i'll", "don't", "there", "here", "very", "just", "too", "out", "all"]);
const clozeBare = (w) => w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");

/**
 * Fill-the-gap: one meaningful word of `text` left out, and four words to choose from (the
 * right one and three from `pool`, other phrases of the lesson). Null when no word fits.
 * @returns {{before: string, answer: string, after: string, options: string[]} | null}
 */
export function clozeItem(text, pool = [], random = Math.random) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const candidates = words.map((raw, i) => ({ i, w: clozeBare(raw) }))
    .filter(({ w }) => /^[A-Za-z][A-Za-z-]*$/.test(w) && w.length >= 3 && !CLOZE_SKIP.has(w.toLowerCase())); // no contractions
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.w.length - a.w.length);
  const top = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2))); // the longer words
  const { i, w: answer } = top[Math.floor(random() * top.length)];
  const raw = words[i];
  const start = raw.indexOf(answer);
  const before = (i ? `${words.slice(0, i).join(" ")} ` : "") + raw.slice(0, start);
  const after = raw.slice(start + answer.length) + (i < words.length - 1 ? " " : "") + words.slice(i + 1).join(" ");
  const capital = /^[A-Z]/.test(answer);
  const seen = new Set([answer.toLowerCase()]);
  const others = [];
  for (const phrase of pool) {
    for (const part of String(phrase).split(/\s+/)) {
      const w = clozeBare(part);
      if (!/^[A-Za-z][A-Za-z-]*$/.test(w) || w.length < 3 || seen.has(w.toLowerCase()) || CLOZE_SKIP.has(w.toLowerCase())) continue;
      if (!capital && /^[A-Z]/.test(w) && w !== "I") continue; // a name in a lowercase gap would give itself away
      seen.add(w.toLowerCase());
      others.push(capital ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase());
    }
  }
  const near = others.filter((w) => Math.abs(w.length - answer.length) <= 3);
  const distractors = testQuestions(near.length >= 3 ? near : others, 3, random);
  return { before, answer, after, options: testQuestions([answer, ...distractors], 4, random) };
}

/**
 * The daily workout: phrases due for review and new ones, interleaved. A new phrase is introduced
 * ("intro") and checked a few items later; reviews and checks rotate through `formats`, so each
 * phrase is recalled a different way (dictation, translation, speaking, fill-the-gap).
 * @returns {{phrase: object, format: string}[]}
 */
export function buildWorkout({ due = [], fresh = [], size = 20, formats = ["dictation", "write", "cloze", "speak"], random = Math.random } = {}) {
  const seen = new Set();
  const once = (list) => list.filter((p) => p && !seen.has(p.en) && seen.add(p.en));
  const reviews = once(due);
  const learn = once(fresh);
  // New phrases take two places each; up to a third of the session, more when little is due.
  const newCount = Math.min(learn.length, Math.max(Math.floor(size / 3), Math.floor((size - reviews.length) / 2)));
  const reviewCount = Math.min(reviews.length, size - newCount * 2);
  let f = Math.floor(random() * formats.length);
  const format = () => formats[f++ % formats.length];
  const items = [];
  const checks = []; // new phrases waiting to be checked: { phrase, at }
  let r = 0;
  let n = 0;
  while (r < reviewCount || n < newCount || checks.length) {
    const ready = checks.findIndex((c) => c.at <= items.length);
    if (ready >= 0) {
      items.push({ phrase: checks.splice(ready, 1)[0].phrase, format: format() });
    } else if (n < newCount && (items.length % 2 === 1 || r >= reviewCount)) {
      items.push({ phrase: learn[n], format: "intro" });
      checks.push({ phrase: learn[n++], at: items.length + 2 });
    } else if (r < reviewCount) {
      items.push({ phrase: reviews[r++], format: format() });
    } else {
      items.push({ phrase: checks.shift().phrase, format: format() });
    }
  }
  return items;
}

/** The seven levels, A (first words) to G (like a native speaker). */
export const LEVEL_LETTERS = "ABCDEFG";

/**
 * One step of the placement test, after a block of questions at level `i`: go up after a passed
 * level, down after a failed one, and stop where a passed level meets a failed one above it.
 * @returns {{results: object, next?: number, level?: string}} `level` is where she should start.
 */
export function placementStep(results, i, passed) {
  const r = { ...results, [LEVEL_LETTERS[i]]: passed };
  if (passed) {
    if (r[LEVEL_LETTERS[i + 1]] === false) return { results: r, level: LEVEL_LETTERS[i + 1] };
    if (i === LEVEL_LETTERS.length - 1) return { results: r, level: LEVEL_LETTERS[i] };
    return { results: r, next: i + 1 };
  }
  if (i === 0 || r[LEVEL_LETTERS[i - 1]] === true) return { results: r, level: LEVEL_LETTERS[i] };
  return { results: r, next: i - 1 };
}

/**
 * Word timings guessed from where the voice is in a clip: words spread over [start, end] seconds
 * by length, with a short pause at a comma (for the talking face when no timings came with the
 * audio).
 * @returns {{w: string, s: number, e: number}[]}
 */
export function spreadWords(text, [start, end]) {
  const parts = String(text).match(/[\p{L}\p{N}'’]+|[,;:—–]/gu) ?? [];
  const weight = (p) => (/^[,;:—–]$/.test(p) ? 3 : p.replace(/['’]/g, "").length + 1.5);
  const total = parts.reduce((sum, p) => sum + weight(p), 0) || 1;
  const words = [];
  let t = start;
  for (const p of parts) {
    const d = ((end - start) * weight(p)) / total;
    if (!/^[,;:—–]$/.test(p)) words.push({ w: p, s: t, e: t + d });
    t += d;
  }
  return words;
}
