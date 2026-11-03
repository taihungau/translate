import { test } from "node:test";
import assert from "node:assert/strict";
import { dictionary } from "cmu-pronouncing-dictionary"; // the same version pronounce.js downloads
import { enToCyrillic } from "../public/pronounce.js";
import { LESSONS } from "../public/lessons.js";
import { compareSpeech, tokens, grade, isLearned, isDue, INTERVALS } from "../public/learn-core.js";

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
