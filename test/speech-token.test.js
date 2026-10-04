import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSpeechToken, speechConfig } from "../lib/handler.js";

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

test("reports whether cloud speech is configured", () =>
  withEnv({ DEEPGRAM_API_KEY: undefined }, () => assert.equal(speechConfig().cloudSpeech, false)).then(() =>
    withEnv({ DEEPGRAM_API_KEY: "k" }, () => assert.equal(speechConfig().cloudSpeech, true))));

test("explains a missing Deepgram key", () =>
  withEnv({ DEEPGRAM_API_KEY: undefined, ACCESS_CODE: undefined }, async () => {
    const res = await handleSpeechToken();
    assert.equal(res.status, 503);
    assert.match(res.body.error, /DEEPGRAM_API_KEY/);
  }));

test("exchanges the key for a short-lived token without exposing the key", () =>
  withEnv({ DEEPGRAM_API_KEY: "secret-key", ACCESS_CODE: undefined }, async () => {
    const realFetch = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, auth: init.headers.Authorization, method: init.method };
      return new Response(JSON.stringify({ access_token: "jwt-123", expires_in: 30 }), { status: 200 });
    };
    try {
      const res = await handleSpeechToken();
      assert.deepEqual(res, { status: 200, body: { token: "jwt-123", expiresIn: 30 } });
      assert.deepEqual(seen, { url: "https://api.deepgram.com/v1/auth/grant", auth: "Token secret-key", method: "POST" });
      assert.doesNotMatch(JSON.stringify(res), /secret-key/);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("reports a key Deepgram rejects", () =>
  withEnv({ DEEPGRAM_API_KEY: "bad", ACCESS_CODE: undefined }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ err_msg: "Invalid credentials." }), { status: 401 });
    try {
      const res = await handleSpeechToken();
      assert.equal(res.status, 502);
      assert.match(res.body.error, /Invalid credentials/);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("requires the access code when one is set", () =>
  withEnv({ DEEPGRAM_API_KEY: "k", ACCESS_CODE: "abc" }, async () => {
    assert.equal((await handleSpeechToken("nope")).status, 401);
  }));
