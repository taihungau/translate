import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTts, speechConfig, TTS_VOICES } from "../lib/handler.js";

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

async function withFetch(reply, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return reply(); };
  try { return await fn(calls); } finally { globalThis.fetch = realFetch; }
}

test("reads English aloud with an American Deepgram voice, keeping the key on the server", () =>
  withEnv({ DEEPGRAM_API_KEY: "secret-key", ACCESS_CODE: undefined }, () =>
    withFetch(() => new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { status: 200 }), async (calls) => {
      const res = await handleTts("  Can I have a coffee, please?  ", "female");
      assert.equal(res.status, 200);
      assert.deepEqual([...res.audio], [0xff, 0xf3, 1, 2]);
      assert.equal(calls[0].url, `https://api.deepgram.com/v1/speak?model=${TTS_VOICES.female}&encoding=mp3`);
      assert.equal(calls[0].init.headers.Authorization, "Token secret-key");
      assert.deepEqual(JSON.parse(calls[0].init.body), { text: "Can I have a coffee, please?" });
      await handleTts("Hello", "male");
      assert.match(calls[1].url, /aura-2-orion-en/);
    })));

test("refuses empty, overlong or unknown-voice requests before calling Deepgram", () =>
  withEnv({ DEEPGRAM_API_KEY: "k", ACCESS_CODE: undefined }, () =>
    withFetch(() => { throw new Error("should not be called"); }, async () => {
      assert.equal((await handleTts("", "female")).status, 400);
      assert.equal((await handleTts("x".repeat(301), "female")).status, 400);
      assert.equal((await handleTts("Hello", "robot")).status, 400);
      assert.equal((await handleTts("Hello", "toString")).status, 400);
    })));

test("needs the access code when one is set, and explains a missing key", async () => {
  await withEnv({ DEEPGRAM_API_KEY: "k", ACCESS_CODE: "1234" }, async () => {
    assert.equal((await handleTts("Hello", "female", "nope")).status, 401);
  });
  await withEnv({ DEEPGRAM_API_KEY: undefined, ACCESS_CODE: undefined }, async () => {
    const res = await handleTts("Hello");
    assert.equal(res.status, 503);
    assert.equal(speechConfig().tts, false);
  });
});

test("passes on Deepgram's reason when it refuses", () =>
  withEnv({ DEEPGRAM_API_KEY: "k", ACCESS_CODE: undefined }, () =>
    withFetch(() => new Response(JSON.stringify({ err_msg: "Insufficient permissions" }), { status: 403 }), async () => {
      const res = await handleTts("Hello");
      assert.equal(res.status, 502);
      assert.match(res.body.error, /403.*Insufficient permissions/);
    })));
