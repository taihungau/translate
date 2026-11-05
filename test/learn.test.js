import { test } from "node:test";
import assert from "node:assert/strict";
import { dictionary } from "cmu-pronouncing-dictionary"; // the same version pronounce.js downloads
import { enToCyrillic } from "../public/pronounce.js";
import { readFileSync } from "node:fs";
import { TRACKS, LEVELS, LESSONS } from "../public/lessons.js";
import { compareSpeech, checkWriting, oneLetterOff, testQuestions, choices, tokens, grade, isLearned, isDue, INTERVALS, dayKey, streak } from "../public/learn-core.js";

const marks = (r) => r.words.map((w) => (w.ok ? w.word : `[${w.word}]`)).join(" ");

test("every lesson phrase has its Russian-letter pronunciation, as live subtitles write it", () => {
  const seen = new Set();
  for (const lesson of LESSONS) {
    assert.ok(lesson.id && lesson.title && lesson.phrases.length, lesson.id);
    for (const p of lesson.phrases) {
      assert.ok(p.en && p.ru && p.say, p.en);
      assert.equal(p.say, enToCyrillic(p.en, dictionary), p.en);
      assert.ok(!seen.has(p.en), `duplicate phrase: ${p.en}`);
      seen.add(p.en);
    }
  }
});

test("the course hangs together: tracks, levels, unique hash-safe ids and an icon for every lesson", () => {
  const html = readFileSync(new URL("../public/learn.html", import.meta.url), "utf8");
  const sprite = new Set([...html.matchAll(/<symbol id="u-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const trackIds = new Set(TRACKS.map((t) => t.id));
  for (const t of TRACKS) assert.ok(sprite.has(t.icon), `track icon ${t.icon}`);
  for (const level of LEVELS) assert.ok(trackIds.has(level.track), `level ${level.id}`);
  const ids = new Set();
  for (const lesson of LESSONS) {
    assert.match(lesson.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(lesson.id) && !trackIds.has(lesson.id) && !["review", "films"].includes(lesson.id), `duplicate or reserved id ${lesson.id}`);
    ids.add(lesson.id);
    assert.ok(LEVELS.some((l) => l.id === lesson.level), `${lesson.id}: level ${lesson.level}`);
    assert.ok(sprite.has(lesson.icon), `${lesson.id}: icon ${lesson.icon} is not in learn.html`);
    assert.ok(lesson.goal && lesson.grammar, lesson.id);
    for (const row of lesson.table ?? []) assert.ok(row.form && row.en && row.ru, `${lesson.id} table`);
    for (const m of lesson.mistakes ?? []) assert.ok(m.wrong && m.right && m.why && m.wrong !== m.right, `${lesson.id} mistakes`);
  }
  for (const t of TRACKS) assert.ok(LESSONS.some((l) => LEVELS.find((v) => v.id === l.level).track === t.id), `empty track ${t.id}`);
});

test("compares what was said with the phrase, word by word", () => {
  const perfect = compareSpeech("Can I have a coffee, please?", "can I have a coffee please");
  assert.equal(perfect.score, 1);
  assert.equal(marks(perfect), "Can I have a coffee, please?");

  const missed = compareSpeech("Where is the nearest subway station?", "where is nearest station");
  assert.equal(marks(missed), "Where is [the] [nearest] [subway] station?".replace("[nearest]", "nearest"));
  assert.equal(missed.score, 4 / 6);

  assert.equal(compareSpeech("I loved this movie!", "").score, 0);
});

test("contractions, digits and sound-alike words count as the same", () => {
  assert.equal(compareSpeech("I'm fine, thanks.", "I am fine thanks").score, 1);
  assert.equal(compareSpeech("I don't think so.", "I do not think so").score, 1);
  assert.equal(compareSpeech("Two tickets, please.", "2 tickets please").score, 1);
  assert.equal(compareSpeech("A table for two, please.", "a table for to please").score, 1);
  assert.equal(compareSpeech("I'm twenty-five years old.", "I'm 25 years old").score, 1);
  assert.equal(compareSpeech("It's ten o'clock.", "it's 10 o'clock").score, 1);
  assert.deepEqual(tokens("What’s up?"), ["what", "is", "up"]);
});

test("a written answer must have every word and nothing extra; case and punctuation don't matter", () => {
  const right = (typed, answer = "Can I have a coffee, please?") => checkWriting(answer, typed).correct;
  assert.ok(right("can i have a coffee please"));
  assert.ok(right("Can I have a coffee, please?!"));
  assert.ok(right("I am fine thanks", "I'm fine, thanks."), "contractions");
  assert.ok(right("I don’t know", "I do not know."), "curly apostrophe");
  assert.ok(!right("Can I have coffee, please?"), "a missing article is a mistake");
  assert.ok(!right("Can I have a coffee, please, now?"), "an extra word is a mistake");
  assert.ok(!right(""));
  assert.ok(!right("   —  "));

  const r = checkWriting("He works in a bank.", "He work in bank");
  assert.deepEqual(r.answer.map((w) => [w.word, w.ok]), [["He", true], ["works", false], ["in", true], ["a", false], ["bank.", true]]);
  assert.deepEqual(r.fixes, [{ typed: "work", right: "works" }], "one letter off is pointed out, still a mistake");
  assert.ok(!r.correct);
  assert.equal(r.score, (2 * 3) / (5 + 4));

  const extra = checkWriting("I went to the cinema.", "I go to the cinema very");
  assert.deepEqual(extra.typed.filter((w) => !w.ok).map((w) => w.word), ["go", "very"]);
  assert.deepEqual(extra.fixes, [], "go → went is not a typo");
});

test("one letter off: added, missing, changed or two swapped, in words of three letters or more", () => {
  assert.ok(oneLetterOff("cofee", "coffee"));
  assert.ok(oneLetterOff("work", "works"));
  assert.ok(oneLetterOff("form", "from"));
  assert.ok(oneLetterOff("teh", "the"));
  assert.ok(oneLetterOff("whit", "with") === false);
  assert.ok(!oneLetterOff("is", "it"), "too short to tell");
  assert.ok(!oneLetterOff("go", "went"));
  assert.ok(!oneLetterOff("same", "same"));
});

test("a test asks the lesson's phrases in a new order, each once", () => {
  const phrases = LESSONS[0].phrases;
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const asked = testQuestions(phrases, 6, random);
  assert.equal(asked.length, Math.min(6, phrases.length));
  assert.equal(new Set(asked).size, asked.length);
  assert.ok(asked.every((p) => phrases.includes(p)));
  assert.equal(testQuestions(phrases, 100).length, phrases.length);
});

test("multiple choice: the right answer and three others, each once", () => {
  const pool = ["a", "b", "c", "d", "e", "b"];
  for (let i = 0; i < 20; i++) {
    const options = choices("b", pool);
    assert.equal(options.length, 4);
    assert.ok(options.includes("b"));
    assert.equal(new Set(options).size, 4);
  }
  assert.deepEqual(choices("a", ["a", "b"]).sort(), ["a", "b"], "a short lesson gives fewer options");
});

test("seven levels, A to G, mean the same in every track", () => {
  assert.deepEqual([...new Set(LEVELS.map((l) => l.badge))].sort().join(""), "ABCDEFG");
  for (const t of TRACKS) {
    const letters = LEVELS.filter((l) => l.track === t.id).map((l) => l.badge).join("");
    assert.ok("ABCDEFG".includes(letters), `${t.id}: ${letters} in order`);
  }
  const order = LESSONS.map((l) => LEVELS.findIndex((v) => v.id === l.level));
  for (const t of TRACKS) {
    const inTrack = LESSONS.filter((l) => LEVELS.find((v) => v.id === l.level).track === t.id).map((l) => LEVELS.findIndex((v) => v.id === l.level));
    assert.deepEqual(inTrack, [...inTrack].sort((a, b) => a - b), `${t.id}: lessons go from easy to hard`);
  }
  assert.ok(order.length >= 120);
});

test("spaced repetition: known phrases come back later, forgotten ones right away", () => {
  const now = 1_000_000;
  const day = 24 * 60 * 60 * 1000;
  const first = grade(undefined, true, now);
  assert.deepEqual(first, { box: 1, due: now + INTERVALS[1] * day });
  const second = grade(first, true, now);
  assert.equal(second.box, 2);
  assert.ok(isLearned(second));
  assert.deepEqual(grade(second, false, now), { box: 0, due: now });
  assert.ok(isDue({ box: 0, due: now }, now));
  assert.ok(!isDue(undefined, now)); // never seen: new, not due
  assert.equal(grade({ box: INTERVALS.length - 1, due: 0 }, true, now).box, INTERVALS.length - 1);
});

test("daily streak: days in a row, still alive until today is over", () => {
  const today = new Date(2026, 10, 4, 15, 0); // 4 November, afternoon
  assert.equal(dayKey(today), "2026-11-04");
  assert.equal(dayKey(new Date(2026, 0, 9)), "2026-01-09");
  assert.equal(streak({}, today), 0);
  assert.equal(streak({ "2026-11-04": 3 }, today), 1);
  assert.equal(streak({ "2026-11-04": 3, "2026-11-03": 10, "2026-11-02": 1 }, today), 3);
  assert.equal(streak({ "2026-11-03": 10, "2026-11-02": 1 }, today), 2, "not practised yet today");
  assert.equal(streak({ "2026-11-04": 3, "2026-11-02": 1 }, today), 1, "a missed day breaks it");
  assert.equal(streak({ "2026-11-01": 4, "2026-10-31": 2 }, new Date(2026, 10, 1)), 2, "across months");
});
