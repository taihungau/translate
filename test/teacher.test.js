import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTeacher, validateTeacherRequest, sessionDetails, teacherRequest, SYSTEM_PROMPT, MAX_TURNS } from "../lib/teacher.js";
import { handleTts, TEACHER_VOICES, TTS_VOICES } from "../lib/handler.js";
import { LESSONS } from "../public/lessons.js";

const start = { messages: [{ role: "user", content: "[start]" }], context: { level: "B", mode: "lesson", lesson: "hello", voice: "female" } };

// A stand-in for the Anthropic client: streams the given pieces of text, then ends.
function fakeClaude(pieces, { stopReason = "end_turn", failAfter = null } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params, options) {
        calls.push({ params, options });
        return {
          async *[Symbol.asyncIterator]() {
            for (const [i, text] of pieces.entries()) {
              if (failAfter === i) throw new Error("connection lost");
              yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            }
            if (failAfter === pieces.length) throw new Error("connection lost");
          },
          finalMessage: async () => ({ stop_reason: stopReason }),
        };
      },
    },
  };
}

test("the teacher's rules ask for short bilingual turns, questions, games and the line format", () => {
  for (const must of ["ru:", "en:", "card:", "choices:", "fix:", "star:", "mood:", "note:", "learned:", "question", "ONE language", "[said]", "[tapped]", "[start]"]) {
    assert.ok(SYSTEM_PROMPT.includes(must), `system prompt mentions ${must}`);
  }
});

test("the session details carry her level, the lesson and its phrases, review phrases and notes", () => {
  const details = sessionDetails({ voice: "male", level: "C", mode: "review", lesson: "hello", review: ["What's your name?", "not a course phrase"], notes: ["name: Masha", "  ", 42], hour: 9, stars: 3 });
  assert.match(details, /You are Alex \(in Russian: Алекс\)/);
  assert.match(details, /Her level: C \(≈ A2 on the CEFR scale\)/);
  assert.match(details, /Mode: review\./);
  for (const p of LESSONS.find((l) => l.id === "hello").phrases) assert.ok(details.includes(`- ${p.en} — ${p.ru}`));
  assert.match(details, /Due for review[\s\S]*What's your name\? — Как тебя зовут\?/);
  assert.ok(!details.includes("not a course phrase"), "only real course phrases are listed");
  assert.match(details, /- name: Masha/);
  assert.match(details, /local time: 09:00/);
  // Unknown values fall back to safe defaults.
  const plain = sessionDetails({ level: "Z", mode: "hack", lesson: "nope" });
  assert.match(plain, /Her level: A/);
  assert.match(plain, /Mode: lesson\./);
  assert.match(plain, /Nothing yet/);
});

test("the request: fast model with thinking off, the rules cached apart from the session", () => {
  const req = teacherRequest(start);
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.deepEqual(req.thinking, { type: "between_tools" });
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.system[0].text, SYSTEM_PROMPT);
  assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
  assert.match(req.system[1].text, /# This session/);
  assert.deepEqual(req.cache_control, { type: "ephemeral" });
  assert.deepEqual(req.messages, [{ role: "user", content: "[start]" }]);
});

test("only well-formed conversations are accepted", () => {
  assert.equal(validateTeacherRequest(start), null);
  assert.match(validateTeacherRequest({}), /messages/);
  assert.match(validateTeacherRequest({ messages: [{ role: "assistant", content: "hi" }] }), /alternate/);
  assert.match(validateTeacherRequest({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }), /last message/);
  assert.match(validateTeacherRequest({ messages: [{ role: "user", content: " " }] }), /text/);
  assert.match(validateTeacherRequest({ messages: [{ role: "user", content: "x".repeat(2001) }] }), /text/);
  const many = Array.from({ length: MAX_TURNS + 1 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" }));
  assert.match(validateTeacherRequest({ messages: many }), /messages must contain/);
  assert.match(validateTeacherRequest({ ...start, context: [] }), /context/);
});

test("a turn streams Claude's words as they come, with the abort signal passed on", async () => {
  const claude = fakeClaude(["mood: happy\nru: При", "вет!\nen: What's your name?\n"]);
  const written = [];
  const stop = new AbortController();
  const res = await handleTeacher(start, undefined, (t) => written.push(t), { anthropic: claude, signal: stop.signal });
  assert.equal(res.status, 200);
  assert.deepEqual(written, ["mood: happy\nru: При", "вет!\nen: What's your name?\n"]);
  assert.equal(claude.calls[0].options.signal, stop.signal);
});

test("a refusal or a broken stream still ends with something kind to say", async () => {
  let written = "";
  await handleTeacher(start, undefined, (t) => { written += t; }, { anthropic: fakeClaude(["en: Hi!"], { stopReason: "refusal" }) });
  assert.match(written, /^en: Hi!\nmood: kind\nru: .+\nen: .+\n$/);
  written = "";
  const res = await handleTeacher(start, undefined, (t) => { written += t; }, { anthropic: fakeClaude(["ru: Привет", "!"], { failAfter: 1 }) });
  assert.equal(res.status, 200);
  assert.match(written, /^ru: Привет\nmood: kind\nru: /);
});

test("errors before the first word are answered as errors; the access code is checked", async () => {
  const failing = fakeClaude([], { failAfter: 0 });
  const res = await handleTeacher(start, undefined, () => assert.fail("nothing to write"), { anthropic: failing });
  assert.equal(res.status, 500);
  const saved = process.env.ACCESS_CODE;
  process.env.ACCESS_CODE = "1234";
  try {
    assert.equal((await handleTeacher(start, "nope", () => {}, { anthropic: fakeClaude([]) })).status, 401);
    assert.equal((await handleTeacher(start, "1234", () => {}, { anthropic: fakeClaude([]) })).status, 200);
  } finally {
    if (saved === undefined) delete process.env.ACCESS_CODE;
    else process.env.ACCESS_CODE = saved;
  }
  assert.equal((await handleTeacher({ messages: [] }, undefined, () => {}, { anthropic: fakeClaude([]) })).status, 400);
});

// ---- the teacher's voices
async function withDeepgram(replies, fn) {
  const realFetch = globalThis.fetch;
  const saved = { key: process.env.DEEPGRAM_API_KEY, code: process.env.ACCESS_CODE };
  process.env.DEEPGRAM_API_KEY = "k";
  delete process.env.ACCESS_CODE;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return replies(url); };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.key === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = saved.key;
    if (saved.code !== undefined) process.env.ACCESS_CODE = saved.code;
  }
}
const mp3 = () => new Response(new Uint8Array([0xff, 0xf3, 9]), { status: 200 });

test("the teacher speaks Russian and English with Deepgram's Flux voices", () =>
  withDeepgram(mp3, async (calls) => {
    assert.equal((await handleTts("Привет! Как дела?", "female", undefined, { lang: "ru", teacher: true })).status, 200);
    assert.equal(calls[0].url, `https://api.deepgram.com/v2/speak?model=${TEACHER_VOICES.female.ru}&encoding=mp3`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: "Привет! Как дела?" });
    await handleTts("What's your name?", "male", undefined, { lang: "en", teacher: true });
    assert.equal(calls[1].url, `https://api.deepgram.com/v2/speak?model=${TEACHER_VOICES.male.en}&encoding=mp3`);
    // Russian also without the teacher flag (there is no other Russian voice); the course's English is unchanged.
    await handleTts("Привет", "male", undefined, { lang: "ru" });
    assert.match(calls[2].url, /flux-mikhail-ru/);
    await handleTts("Hello", "female");
    assert.match(calls[3].url, new RegExp(`/v1/speak\\?model=${TTS_VOICES.female}`));
  }));

test("if Flux fails, her English falls back to the course voice; Russian reports the failure", () =>
  withDeepgram((url) => (url.includes("/v2/") ? new Response(JSON.stringify({ err_msg: "nope" }), { status: 400 }) : mp3()), async (calls) => {
    const en = await handleTts("Hello", "female", undefined, { lang: "en", teacher: true });
    assert.equal(en.status, 200);
    assert.match(calls[1].url, /aura-2-thalia-en/);
    const ru = await handleTts("Привет", "female", undefined, { lang: "ru", teacher: true });
    assert.equal(ru.status, 502);
    assert.equal((await handleTts("Hola", "female", undefined, { lang: "es" })).status, 400);
  }));
