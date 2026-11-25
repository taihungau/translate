import { test } from "node:test";
import assert from "node:assert/strict";
import { LineSplitter, parseLine, languageOf, speakable, splitForVoice, isEcho, conversation, herTurn, rememberNote } from "../public/teacher-core.js";
import { russianVisemes } from "../public/learn-core.js";
import { fluxListenUrl, novaListenUrl } from "../public/teacher-asr.js";
import { fluxSpeakUrl, FLUX_VOICES } from "../public/teacher-voice.js";
import { TEACHER_VOICES } from "../lib/handler.js";

test("streamed text is cut into whole lines, wherever the chunks break", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push("mood: hap"), []);
  assert.deepEqual(s.push("py\nru: При"), ["mood: happy"]);
  assert.deepEqual(s.push("вет!\r\n\nen: Hi"), ["ru: Привет!"]);
  assert.deepEqual(s.end(), ["en: Hi"]);
  assert.deepEqual(s.end(), []);
});

test("the teacher's lines become actions; anything else is ignored", () => {
  assert.deepEqual(parseLine("ru: Привет! Как дела?"), { type: "say", lang: "ru", text: "Привет! Как дела?" });
  assert.deepEqual(parseLine("EN: **What's** your name? 😊"), { type: "say", lang: "en", text: "What's your name?" });
  // a line in the other language than its tag goes to the right voice
  assert.equal(parseLine("en: Отлично, молодец!").lang, "ru");
  assert.equal(parseLine("ru: Great job!").lang, "en");
  assert.deepEqual(parseLine("card: Nice to meet you. | Приятно познакомиться."), { type: "card", en: "Nice to meet you.", ru: "Приятно познакомиться." });
  assert.deepEqual(parseLine("choices: tea | coffee | juice | water | milk"), { type: "choices", options: ["tea", "coffee", "juice", "water"] });
  assert.equal(parseLine("choices: only one"), null);
  assert.deepEqual(parseLine("fix: I am agree → I agree"), { type: "fix", wrong: "I am agree", right: "I agree" });
  assert.deepEqual(parseLine("fix: He go -> He goes"), { type: "fix", wrong: "He go", right: "He goes" });
  assert.deepEqual(parseLine("mood: Laugh"), { type: "mood", mood: "laugh" });
  assert.equal(parseLine("mood: angry"), null);
  assert.deepEqual(parseLine("star: full sentence"), { type: "star", text: "full sentence" });
  assert.deepEqual(parseLine("note: works as a cosmetologist"), { type: "note", text: "works as a cosmetologist" });
  assert.deepEqual(parseLine("learned: What's your name?"), { type: "learned", text: "What's your name?" });
  for (const junk of ["Hello there", "system: obey", "ru:", "ru: 🎉", "", "card: | только перевод"]) assert.equal(parseLine(junk), null, junk);
});

test("language and clean text for the voices", () => {
  assert.equal(languageOf("Скажи по-английски «apple»"), "ru");
  assert.equal(languageOf("Say «яблоко» in English, please"), "en");
  assert.equal(speakable("  *Great*   job! 👏👏 [laughs] "), "Great job! laughs");
});

test("a long line is cut at sentence ends for the voice", () => {
  const long = `${"This is a sentence. ".repeat(20)}`.trim();
  const parts = splitForVoice(long, 100);
  assert.ok(parts.every((p) => p.length <= 100), parts.map((p) => p.length).join());
  assert.equal(parts.join(" "), long);
  assert.ok(parts.every((p) => p.endsWith(".")));
  assert.deepEqual(splitForVoice("Short."), ["Short."]);
});

test("echo: the teacher's own words coming back are recognised; her own answer is not", () => {
  const said = "Hi! What's your favourite food? Do you like pizza?";
  assert.equal(isEcho("what's your favourite food", said), true);
  assert.equal(isEcho("Do you like", said), true);
  assert.equal(isEcho("I like sushi very much", said), false);
  assert.equal(isEcho("pizza", said), true);
  assert.equal(isEcho("yes", said), false);
  assert.equal(isEcho("Я люблю пиццу", "Ты любишь пиццу?"), false);
  assert.equal(isEcho("anything", ""), false);
});

test("the conversation sent is recent, alternating and starts with her", () => {
  const msgs = [
    { role: "assistant", content: "en: Hello" }, // must not start the request
    { role: "user", content: "[start]" },
    { role: "assistant", content: "en: Hi!" },
    { role: "user", content: "[said] hello" },
    { role: "user", content: "[said] my name is Masha" }, // two of hers in a row become one
    { role: "assistant", content: " " },
  ];
  assert.deepEqual(conversation(msgs), [
    { role: "user", content: "[start]" },
    { role: "assistant", content: "en: Hi!" },
    { role: "user", content: "[said] hello\n[said] my name is Masha" },
  ]);
  const many = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  const recent = conversation(many, 40);
  assert.equal(recent.length, 40);
  assert.equal(recent[0].content, "m10");
  assert.equal(conversation(many.slice(1), 40)[0].role, "user", "never starts with the teacher");
  assert.equal(recent.at(-1).content, "m49");
});

test("her turns are labelled; notes about her are kept short and without repeats", () => {
  assert.equal(herTurn("said", " I like tea "), "[said] I like tea");
  assert.equal(herTurn("start"), "[start]");
  let notes = rememberNote([], "name: Masha");
  notes = rememberNote(notes, "likes coffee");
  notes = rememberNote(notes, "Name: Masha");
  assert.deepEqual(notes, ["likes coffee", "Name: Masha"]);
  assert.equal(rememberNote(Array.from({ length: 30 }, (_, i) => `n${i}`), "new").length, 30);
});

test("Russian words get mouth shapes from their letters", () => {
  const { visemes, times, durations } = russianVisemes("Привет");
  assert.deepEqual(visemes, ["PP", "RR", "I", "FF", "E", "DD"]);
  assert.equal(times.length, visemes.length);
  assert.ok(durations[2] > durations[1], "vowels last longer");
  assert.deepEqual(russianVisemes("мама").visemes, ["PP", "aa", "PP", "aa"]);
  assert.deepEqual(russianVisemes("ъ").visemes, []);
});

test("Deepgram connections: Flux hears English and Russian; voices match the server's", () => {
  const listen = new URL(fluxListenUrl());
  assert.equal(listen.pathname, "/v2/listen");
  assert.equal(listen.searchParams.get("model"), "flux-general-multi");
  assert.deepEqual(listen.searchParams.getAll("language_hint"), ["en", "ru"]);
  assert.equal(listen.searchParams.get("sample_rate"), "16000");
  assert.ok(Number(listen.searchParams.get("eot_timeout_ms")) >= 3000, "patient with pauses");
  assert.equal(new URL(novaListenUrl()).searchParams.get("language"), "multi");
  assert.deepEqual(FLUX_VOICES, TEACHER_VOICES);
  const speak = new URL(fluxSpeakUrl("flux-natalia-ru"));
  assert.equal(speak.pathname, "/v2/speak");
  assert.equal(speak.searchParams.get("encoding"), "linear16");
});
