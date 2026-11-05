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
