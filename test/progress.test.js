import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeProgress, normalizeCode, CODE_ALPHABET } from "../public/learn-sync.js";
import { handleProgress, newCode } from "../lib/progress.js";
import { speechConfig } from "../lib/handler.js";
import { INTERVALS } from "../public/learn-core.js";

const DAY = 24 * 60 * 60 * 1000;
const card = (box, reviewedAt) => ({ box, due: reviewedAt + INTERVALS[box] * DAY });

test("codes: 4 unambiguous characters, typed any way; the first 12-character codes still read", () => {
  assert.equal(normalizeCode("k7qm"), "K7QM");
  assert.equal(normalizeCode(" k7-qm "), "K7QM");
  assert.equal(normalizeCode("k7qm 4tzp-9hxw"), "K7QM-4TZP-9HXW");
  assert.equal(normalizeCode("K7Q"), null, "too short");
  assert.equal(normalizeCode("K7QMX"), null, "five");
  assert.equal(normalizeCode("O7QM"), null, "O is not used: it looks like 0");
  assert.equal(normalizeCode(null), null);
  for (let i = 0; i < 50; i++) {
    const c = newCode();
    assert.match(c, /^[2-9A-Z]{4}$/);
    assert.equal(normalizeCode(c), c);
  }
  assert.ok(!/[01OIL]/.test(CODE_ALPHABET));
});

test("merging two phones: each card keeps its latest answer, scores their best", () => {
  const phoneA = {
    learnProgress: { "Hello!": card(2, 1000 * DAY), "Thank you.": card(3, 1000 * DAY), "Bye.": card(1, 990 * DAY) },
    learnTests: { cafe: { best: 7, last: 5, total: 8, at: 2000 } },
    learnSkills: { cafe: { listen: { best: 4, last: 4, total: 8, at: 10 } } },
    learnStats: { goal: 20, days: { "2026-11-05": 12, "2026-11-06": 3 } },
  };
  const phoneB = {
    learnProgress: { "Hello!": card(3, 1001 * DAY), "Thank you.": card(0, 1002 * DAY), "Where?": card(1, 1000 * DAY) },
    learnTests: { cafe: { best: 6, last: 6, total: 8, at: 3000 }, hello: { best: 8, last: 8, total: 8, at: 1 } },
    learnSkills: { cafe: { listen: { best: 7, last: 7, total: 8, at: 20 }, read: { best: 8, last: 8, total: 8, at: 20 } } },
    learnStats: { goal: 10, days: { "2026-11-06": 9 } },
  };
  const m = mergeProgress(phoneA, phoneB);
  assert.deepEqual(m.learnProgress["Hello!"], card(3, 1001 * DAY), "answered later on B");
  assert.deepEqual(m.learnProgress["Thank you."], card(0, 1002 * DAY), "forgotten later on B: back to the start");
  assert.deepEqual(m.learnProgress["Bye."], card(1, 990 * DAY), "only on A");
  assert.deepEqual(m.learnProgress["Where?"], card(1, 1000 * DAY), "only on B");
  assert.deepEqual(m.learnTests.cafe, { best: 7, last: 6, total: 8, at: 3000 }, "best of both, last try from B");
  assert.deepEqual(m.learnTests.hello, { best: 8, last: 8, total: 8, at: 1 });
  assert.deepEqual(m.learnSkills.cafe, { listen: { best: 7, last: 7, total: 8, at: 20 }, read: { best: 8, last: 8, total: 8, at: 20 } });
  assert.deepEqual(m.learnStats, { goal: 10, days: { "2026-11-05": 12, "2026-11-06": 9 } }, "goal from the newer copy; days keep the larger count");
  assert.deepEqual(mergeProgress(m, m), m, "merging with itself changes nothing");
  assert.deepEqual(mergeProgress(phoneB, phoneA).learnProgress, m.learnProgress, "cards don't depend on the order");
});

test("merging drops anything malformed", () => {
  const m = mergeProgress({}, {
    learnProgress: { ok: card(1, 5), bad: { box: 9, due: 1 }, worse: "x", ["__proto__"]: card(1, 5) },
    learnTests: { "Bad Id": { best: 1, total: 8 }, fine: { best: 9, total: 8 }, good: { best: 3, total: 8, last: 3, at: 4 } },
    learnSkills: { good: { listen: { best: 2, total: 8 }, hack: { best: 1, total: 1 } } },
    learnStats: { goal: 999, days: { "2026-11-06": 3, yesterday: 4, "2026-11-07": -1 } },
    extra: { anything: true },
  });
  assert.deepEqual(Object.keys(m.learnProgress), ["ok"]);
  assert.equal(Object.getPrototypeOf(m.learnProgress), Object.prototype);
  assert.deepEqual(Object.keys(m.learnTests), ["good"]);
  assert.deepEqual(m.learnSkills, { good: { listen: { best: 2, last: 2, total: 8, at: 0 } } });
  assert.deepEqual(m.learnStats, { goal: 10, days: { "2026-11-06": 3 } });
  assert.equal(m.extra, undefined);
  assert.deepEqual(mergeProgress(null, "nonsense"), { learnProgress: {}, learnTests: {}, learnSkills: {}, learnStats: { goal: 10, days: {} } });
});

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

// A pretend Upstash: the REST API takes a Redis command as a JSON array.
async function withRedis(fn) {
  const db = new Map();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const command = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, command });
    const [name, key, value, ...rest] = command;
    let result = null;
    if (name === "GET") result = db.get(key) ?? null;
    if (name === "SET") {
      if (rest.includes("NX") && db.has(key)) result = null;
      else { db.set(key, value); result = "OK"; }
    }
    if (name === "INCR") { result = Number(db.get(key) ?? 0) + 1; db.set(key, String(result)); }
    if (name === "EXPIRE") result = 1;
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  try { return await fn(db, calls); } finally { globalThis.fetch = realFetch; }
}

const env = { KV_REST_API_URL: "https://test.upstash.io/", KV_REST_API_TOKEN: "secret", UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, ACCESS_CODE: undefined };

test("the first save makes a code; later saves from any phone merge into it", () =>
  withEnv(env, () => withRedis(async (db, calls) => {
    assert.equal(speechConfig().sync, true);
    const first = await handleProgress({ data: { learnProgress: { "Hello!": card(1, 100 * DAY) } } });
    assert.equal(first.status, 201);
    const { code } = first.body;
    assert.match(code, /^[2-9A-Z]{4}$/);
    assert.equal(calls[0].url, "https://test.upstash.io");
    assert.equal(calls[0].auth, "Bearer secret");
    assert.deepEqual(calls[0].command.slice(0, 2), ["SET", `progress:${code}`]);
    assert.ok(calls[0].command.includes("NX"));

    const other = await handleProgress({ code: code.toLowerCase(), data: { learnProgress: { "Bye.": card(1, 101 * DAY) } } });
    assert.equal(other.status, 200);
    assert.equal(other.body.code, code);
    assert.deepEqual(Object.keys(other.body.data.learnProgress).sort(), ["Bye.", "Hello!"]);
    assert.deepEqual(Object.keys(JSON.parse(db.get(`progress:${code}`)).data.learnProgress).sort(), ["Bye.", "Hello!"]);

    const empty = await handleProgress({ code, data: {} });
    assert.deepEqual(Object.keys(empty.body.data.learnProgress).sort(), ["Bye.", "Hello!"], "a new phone gets everything");
  })));

test("unknown codes, bad requests, a missing database and the access code", () =>
  withEnv(env, () => withRedis(async () => {
    assert.equal((await handleProgress({ code: "K7QM", data: {} })).status, 404);
    assert.equal((await handleProgress({ code: "nope", data: {} })).status, 400);
    assert.equal((await handleProgress({ data: [] })).status, 400);
    assert.equal((await handleProgress(null)).status, 400);
    assert.equal((await handleProgress({ data: { learnProgress: { x: "y".repeat(500 * 1024) } } })).status, 413);
    await withEnv({ ACCESS_CODE: "1234" }, async () => assert.equal((await handleProgress({ data: {} }, "wrong")).status, 401));
    await withEnv({ KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined }, async () => {
      assert.equal(speechConfig().sync, false);
      assert.equal((await handleProgress({ data: {} })).status, 503);
    });
    await withEnv({ KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined, UPSTASH_REDIS_REST_URL: "https://u.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }, async () => {
      assert.equal(speechConfig().sync, true, "Upstash's own variable names work too");
    });
    await withEnv({ KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined, STORAGE_REST_API_URL: "https://s.upstash.io", STORAGE_REST_API_TOKEN: "t" }, async () => {
      assert.equal(speechConfig().sync, true, "any prefix chosen when connecting the database");
    });
  })));

test("an old 12-character code moves to a short one, and every phone follows", () =>
  withEnv(env, () => withRedis(async (db) => {
    const old = "K7QM-4TZP-9HXW";
    db.set(`progress:${old}`, JSON.stringify({ v: 1, data: { learnProgress: { "Hello!": card(1, 100 * DAY) } } }));
    const phoneA = await handleProgress({ code: old, data: { learnProgress: { "Bye.": card(1, 101 * DAY) } } });
    assert.equal(phoneA.status, 200);
    const short = phoneA.body.code;
    assert.match(short, /^[2-9A-Z]{4}$/);
    assert.deepEqual(Object.keys(phoneA.body.data.learnProgress).sort(), ["Bye.", "Hello!"]);
    assert.equal(JSON.parse(db.get(`progress:${old}`)).movedTo, short, "the old code points to the new one");
    const phoneB = await handleProgress({ code: old.toLowerCase(), data: { learnProgress: { "Where?": card(1, 102 * DAY) } } });
    assert.equal(phoneB.body.code, short, "a phone with the old code is moved to the same short code");
    assert.deepEqual(Object.keys(phoneB.body.data.learnProgress).sort(), ["Bye.", "Hello!", "Where?"]);
    assert.deepEqual(Object.keys(JSON.parse(db.get(`progress:${short}`)).data.learnProgress).sort(), ["Bye.", "Hello!", "Where?"]);
  })));
