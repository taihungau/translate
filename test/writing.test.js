import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSentence, buildWritingMessage, WritingRefusedError, SYSTEM_PROMPT } from "../lib/writing.js";
import { handleCheckWriting, speechConfig } from "../lib/handler.js";
import { LESSONS } from "../public/lessons.js";

function mockClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => { calls.push(params); return reply; } } },
  };
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

const checked = { verdict: "almost", corrected: "I agree with you.", explanation: "По-английски agree — глагол: I agree, без am." };

test("checks her own sentence with the lesson's topic, as structured output", async () => {
  const lesson = LESSONS[0];
  const anthropic = mockClient({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(checked) }] });
  const out = await checkSentence("I am agree with you unique-1", lesson.id, { anthropic });
  assert.deepEqual(out, checked);
  const params = anthropic.calls[0];
  assert.equal(params.output_config.format.type, "json_schema");
  assert.deepEqual(params.output_config.format.schema.properties.verdict.enum, ["correct", "almost", "wrong"]);
  assert.equal(params.fallbacks, "default");
  assert.equal(params.system, SYSTEM_PROMPT);
  assert.match(params.messages[0].content, /<text>\nI am agree with you unique-1\n<\/text>/);
  assert.ok(params.messages[0].content.includes(lesson.en));

  await checkSentence("I am agree with you unique-1", lesson.id, { anthropic });
  assert.equal(anthropic.calls.length, 1, "the same sentence is answered from the cache");
});

test("an unknown lesson only leaves the topic out", () => {
  assert.equal(buildWritingMessage("Hello", undefined), "Her text:\n<text>\nHello\n</text>");
});

test("a declined check is reported as such", async () => {
  const anthropic = mockClient({ stop_reason: "refusal", stop_details: { explanation: "no" }, content: [] });
  await assert.rejects(checkSentence("unique-2", undefined, { anthropic }), WritingRefusedError);
});

test("the writing check validates input and needs the Claude key", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ACCESS_CODE: undefined }, async () => {
    assert.equal(speechConfig().writing, false);
    assert.equal((await handleCheckWriting({ text: "" })).status, 400);
    assert.equal((await handleCheckWriting({ text: "x".repeat(401) })).status, 400);
    assert.equal((await handleCheckWriting({ text: "Hi", lesson: 5 })).status, 400);
    assert.equal((await handleCheckWriting(null)).status, 400);
    assert.equal((await handleCheckWriting({ text: "Hi" })).status, 503);
    await withEnv({ ANTHROPIC_API_KEY: "k" }, () => assert.equal(speechConfig().writing, true));
    await withEnv({ ACCESS_CODE: "1234" }, async () => assert.equal((await handleCheckWriting({ text: "Hi" }, "nope")).status, 401));
  }));
