// Pronunciation hints: Russian written in Latin letters ("Привет" → "Privet") and English
// written in Russian letters ("Hello" → "хэло́у"), so a reader can say a line aloud.
// Russian spelling is close to how it sounds, so a few rules are enough. English isn't, so
// English words are looked up in the CMU Pronouncing Dictionary (134,000 words, ~1 MB
// compressed, downloaded once when needed); unknown words fall back to spelling rules.

const DICTIONARY_URL = "https://cdn.jsdelivr.net/npm/cmu-pronouncing-dictionary@3.0.0/index.js";

// ---------------------------------------------------------------- Russian → Latin letters
const RU = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
const RU_VOWELS = "аеёиоуыэюя";

// Words not said the way they are spelt.
const RU_SAID = {
  что: "што", чтобы: "штобы", ничто: "ништо", конечно: "конешно", скучно: "скушно",
  сегодня: "севодня", его: "ево", кого: "ково", чего: "чево", ничего: "ничево", того: "тово",
  всего: "всево", никого: "никово", солнце: "сонце", здравствуйте: "здраствуйте",
  здравствуй: "здраствуй", пожалуйста: "пожалуста",
};
// "-ого"/"-его" endings are said "-ово"/"-ево", except in these words.
const RU_OGO_AS_SPELT = new Set(["много", "немного", "строго", "дорого", "недорого", "итого", "убого", "полого", "отлого"]);

function ruSaid(word) {
  if (RU_SAID[word]) return RU_SAID[word];
  let w = word;
  if (w.length > 4 && /[ое]го$/.test(w) && !RU_OGO_AS_SPELT.has(w)) w = w.slice(0, -2) + "во";
  return w.replace(/ть?ся$/, "ца").replace(/сч/g, "щ");
}

function ruWordToLatin(word) {
  const lower = ruSaid(word.toLowerCase());
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    const prev = lower[i - 1];
    if (ch === "е" && (i === 0 || RU_VOWELS.includes(prev) || prev === "ь" || prev === "ъ")) out += "ye";
    else if (ch === "й" && (prev === "ы" || prev === "и") && i === lower.length - 1) out += prev === "и" ? "y" : "";
    else out += RU[ch] ?? ch;
  }
  return matchCase(word, out);
}

/** Russian text with every Cyrillic word written in Latin letters. */
export function ruToLatin(text) {
  return text.replace(/[А-Яа-яЁё]+/g, ruWordToLatin);
}

// ---------------------------------------------------------------- English → Russian letters
// CMU dictionary phones (ARPAbet), with a stress digit on vowels: 1 primary, 2 secondary, 0 none.
const VOWEL = { AA: "а", AE: "э", AH: "а", AO: "о", AW: "ау", AY: "ай", EH: "э", ER: "ёр", EY: "эй", IH: "и", IY: "и", OW: "оу", OY: "ой", UH: "у", UW: "у" };
const CONSONANT = {
  B: "б", CH: "ч", D: "д", DH: "з", F: "ф", G: "г", HH: "х", JH: "дж", K: "к", L: "л", M: "м", N: "н",
  NG: "нг", P: "п", R: "р", S: "с", SH: "ш", T: "т", TH: "с", V: "в", W: "у", Y: "й", Z: "з", ZH: "ж",
};
// Y followed by a vowel becomes one Russian letter: "you" → "ю", "yard" → "ярд".
const IOTATED = { UW: "ю", UH: "ю", AA: "я", AH: "я", AE: "я", EH: "е", AO: "йо", OW: "йоу", IY: "йи", IH: "йи", ER: "йёр", EY: "ей", AY: "йай", AW: "йау", OY: "йой" };
const STRESS = "́"; // combining acute accent: и́
const CYR_VOWELS = "аэоуиыеёюя";

/** One word's ARPAbet phones ("HH AH0 L OW1") written in Russian letters ("хало́у"). */
export function phonesToCyrillic(phones) {
  const list = phones.trim().split(/\s+/).map((p) => {
    const m = /^([A-Z]+)([012])?$/.exec(p);
    return m ? { ph: m[1], stress: m[2] } : { ph: p, stress: undefined };
  });
  const syllables = list.filter((p) => p.stress !== undefined).length;
  let out = "";
  for (let i = 0; i < list.length; i++) {
    const { ph, stress } = list[i];
    const prev = list[i - 1];
    const afterConsonant = Boolean(prev && prev.stress === undefined && prev.ph !== "Y" && prev.ph !== "W");
    let piece;
    if (ph === "Y" && list[i + 1]?.stress !== undefined) {
      // "few" → "фью", "yes" → "ес"
      const next = list[++i];
      piece = (afterConsonant ? "ь" : "") + IOTATED[next.ph];
      out += syllables > 1 && next.stress === "1" ? addStress(piece) : piece;
      continue;
    }
    if (stress !== undefined) {
      piece = VOWEL[ph] ?? "";
      if (ph === "EH" && afterConsonant) piece = "е"; // "bed" → "бед"
      else if (ph === "EY" && afterConsonant) piece = "ей"; // "day" → "дей"
      else if (ph === "ER" && prev?.ph === "W") piece = "ор"; // "world" → "уорлд"
      else if (ph === "ER" && stress !== "1") piece = afterConsonant ? "ер" : "эр"; // "water" → "уотер"
      if (syllables > 1 && stress === "1") piece = addStress(piece);
    } else {
      piece = CONSONANT[ph] ?? "";
    }
    out += piece;
  }
  return out;
}

function addStress(piece) {
  const i = [...piece].findIndex((c) => CYR_VOWELS.includes(c));
  if (i === -1 || piece[i] === "ё") return piece;
  return piece.slice(0, i + 1) + STRESS + piece.slice(i + 1);
}

// Spelling rules for words the dictionary doesn't know (names, slang). Rough, but readable.
const SPELLING = [
  [/^kn/, "н"], [/^wr/, "р"], [/tion/g, "шн"], [/sion/g, "жн"], [/ture/g, "чер"], [/igh/g, "ай"],
  [/gh/g, ""], [/sh/g, "ш"], [/ch/g, "ч"], [/th/g, "с"], [/ph/g, "ф"], [/ck/g, "к"], [/qu/g, "кв"],
  [/wh/g, "у"], [/ee/g, "и"], [/ea/g, "и"], [/oo/g, "у"], [/ou/g, "ау"], [/ow/g, "оу"], [/ai/g, "ей"],
  [/ay/g, "ей"], [/oa/g, "оу"], [/c(?=[eiy])/g, "с"], [/g(?=[ei])/g, "дж"], [/^y/, "й"], [/x/g, "кс"],
  [/(.)\1/g, "$1"], [/([^aeiou])e$/, "$1"],
];
const LETTER = {
  a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "дж", k: "к", l: "л", m: "м",
  n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "у", x: "кс", y: "и", z: "з",
};

function spellToCyrillic(word) {
  let w = word.toLowerCase().replace(/'/g, "");
  for (const [re, to] of SPELLING) w = w.replace(re, to);
  return [...w].map((c) => LETTER[c] ?? c).join("");
}

function enWordToCyrillic(word, dictionary) {
  const lower = word.toLowerCase();
  if (lower === "the") return matchCase(word, "зэ");
  let phones = dictionary?.[lower];
  let suffix = "";
  if (!phones && /'s$/.test(lower) && dictionary?.[lower.slice(0, -2)]) {
    phones = dictionary[lower.slice(0, -2)];
    suffix = "з"; // "Mary's" → "Мэ́риз"
  }
  const cyr = phones ? phonesToCyrillic(phones.split(/\s*,\s*|\s{2,}/)[0]) + suffix : spellToCyrillic(word);
  return matchCase(word, cyr);
}

/** English text with every English word written in Russian letters. */
export function enToCyrillic(text, dictionary) {
  return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)*/g, (w) => enWordToCyrillic(w, dictionary));
}

// ---------------------------------------------------------------- shared
function matchCase(source, out) {
  if (!out) return out;
  const letters = source.replace(/[^\p{L}]/gu, "");
  if (letters.length > 2 && letters === letters.toUpperCase()) return out.toUpperCase();
  if (source[0] !== source[0].toLowerCase()) return out[0].toUpperCase() + out.slice(1);
  return out;
}

let dictionary = null;
let loading = null;

/** Download (first time only) the English dictionary. Resolves when it can be used. */
export function loadDictionary() {
  loading ??= import(DICTIONARY_URL)
    .then((mod) => { dictionary = mod.dictionary; })
    .catch((err) => {
      console.warn("English pronunciation dictionary unavailable, using spelling rules:", err);
      dictionary = {}; // spelling rules only
    });
  return loading;
}

/**
 * How to say `text`, written in the other alphabet, or "" when there is nothing to add.
 * @param {string} text
 * @param {"ru" | "en"} lang the language `text` is in
 */
export function pronounce(text, lang) {
  if (!text) return "";
  if (lang === "ru") {
    if (!/[А-Яа-яЁё]/.test(text)) return "";
    return ruToLatin(text);
  }
  if (!/[A-Za-z]/.test(text) || !dictionary) return "";
  return enToCyrillic(text, dictionary);
}

export const dictionaryReady = () => Boolean(dictionary);
