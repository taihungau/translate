import { test } from "node:test";
import assert from "node:assert/strict";
import { translateLines, TranslationRefusedError, buildUserMessage } from "../translator.js";

function mockClient(reply) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return typeof reply === "function" ? reply(params) : reply;
        },
      },
    },
  };
}

const ok = (translations) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ translations }) }],
});

test("sends a structured-output request and maps results by id", async () => {
  const anthropic = mockClient(ok([{ id: "a", ru: "Привет" }, { id: "b", ru: "Пока" }]));
  const out = await translateLines(
    [{ id: "a", text: "Hello unique-1" }, { id: "b", text: "Bye unique-1" }, { id: "c", text: "  " }],
    ["earlier line"],
    { anthropic },
  );
  assert.deepEqual(out, [
    { id: "a", text: "Привет" },
    { id: "b", text: "Пока" },
    { id: "c", text: "" },
  ]);
  const params = anthropic.calls[0];
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.fallbacks, "default");
  assert.match(params.messages[0].content, /earlier line/);
});

test("serves repeated lines from cache", async () => {
  const anthropic = mockClient(ok([{ id: "1", ru: "Да" }]));
  await translateLines([{ id: "1", text: "Yes unique-2" }], [], { anthropic });
  const out = await translateLines([{ id: "9", text: "Yes unique-2" }], [], { anthropic });
  assert.deepEqual(out, [{ id: "9", text: "Да" }]);
  assert.equal(anthropic.calls.length, 1);
});

test("omits lines the model did not return", async () => {
  const anthropic = mockClient(ok([{ id: "x", ru: "Икс" }]));
  const out = await translateLines([{ id: "x", text: "X unique-3" }, { id: "y", text: "Y unique-3" }], [], { anthropic });
  assert.deepEqual(out, [{ id: "x", text: "Икс" }]);
});

test("throws TranslationRefusedError on refusal", async () => {
  const anthropic = mockClient({ stop_reason: "refusal", stop_details: { explanation: "nope" }, content: [] });
  await assert.rejects(translateLines([{ id: "1", text: "unique-4" }], [], { anthropic }), TranslationRefusedError);
});

test("buildUserMessage includes context only when given", () => {
  assert.doesNotMatch(buildUserMessage([{ id: "1", text: "Hi" }]), /context/);
  assert.match(buildUserMessage([{ id: "1", text: "Hi" }], ["prev"]), /> prev/);
});
