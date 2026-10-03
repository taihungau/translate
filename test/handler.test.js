import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/translate.js";

function call(method, body, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ method, body, headers }, res);
  });
}

test("rejects non-POST and malformed bodies", async () => {
  assert.equal((await call("GET")).status, 405);
  assert.equal((await call("POST", undefined)).status, 400);
  assert.equal((await call("POST", { lines: [] })).status, 400);
  assert.equal((await call("POST", { lines: [{ id: 1, text: "x" }] })).status, 400);
});

test("enforces ACCESS_CODE when set", async () => {
  process.env.ACCESS_CODE = "secret";
  try {
    const denied = await call("POST", { lines: [{ id: "1", text: "Hi" }] });
    assert.equal(denied.status, 401);
    const wrong = await call("POST", { lines: [] }, { "x-access-code": "nope" });
    assert.equal(wrong.status, 401);
    const allowedButInvalid = await call("POST", { lines: [] }, { "x-access-code": "secret" });
    assert.equal(allowedButInvalid.status, 400);
  } finally {
    delete process.env.ACCESS_CODE;
  }
});
