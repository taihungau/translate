// The Learn page's logic that doesn't touch the screen: checking what was said against the
// phrase, and when a phrase should come back (spaced repetition, like paper flashcards in boxes).

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

/**
 * How well `heard` (what speech recognition wrote) matches `phrase`: each word of the phrase
 * marked as said or missed, and the share of the phrase's words that were said, in order.
 * @returns {{words: {word: string, ok: boolean}[], score: number}}
 */
export function compareSpeech(phrase, heard) {
  const display = phrase.split(/\s+/).filter(Boolean);
  const parts = display.map(expand);
  const want = parts.flat();
  const got = tokens(heard);

  // Longest common subsequence: the most phrase words said in the right order.
  const n = want.length;
  const m = got.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = want[i] === got[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hit = new Array(n).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (want[i] === got[j]) { hit[i] = true; i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }

  let k = 0;
  const words = display.map((word, d) => {
    let ok = true;
    for (let t = 0; t < parts[d].length; t++) ok = hit[k++] && ok;
    return { word, ok };
  });
  return { words, score: n ? hit.filter(Boolean).length / n : 0 };
}

export function verdict(score) {
  if (score >= 0.9) return "Отлично! Так и говорят.";
  if (score >= 0.6) return "Почти! Красным отмечены слова, которые не расслышали.";
  return "Ещё разок: послушайте медленно и повторите.";
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
