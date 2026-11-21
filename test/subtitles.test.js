import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseSubtitles, toSrt, findCueAt, parseTimestamp, readingTime, liveView } from "../public/subtitles.js";

test("parses SRT with multi-line cues and strips tags", async () => {
  const cues = parseSubtitles(await readFile(new URL("../samples/sample.en.srt", import.meta.url), "utf8"));
  assert.equal(cues.length, 5);
  assert.equal(cues[1].text, "Oh man, thanks.\nI'd lose my head if it wasn't attached.");
  assert.equal(cues[4].text, "Too late. It's already here.");
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.2);
});

test("parses WebVTT with header, short timestamps and cue settings", () => {
  const vtt = "WEBVTT\n\nNOTE hello\n\nintro\n00:01.500 --> 00:03.000 align:center\n<v Bob>Hi there</v>\n\n00:00:04.000 --> 00:00:05.000\n{\\an8}Up top\n";
  const cues = parseSubtitles(vtt);
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [
    [1.5, 3, "Hi there"],
    [4, 5, "Up top"],
  ]);
});

test("handles CRLF and BOM", () => {
  const cues = parseSubtitles("﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Hello");
});

test("round-trips through SRT", () => {
  const cues = parseSubtitles("1\n01:02:03,045 --> 01:02:04,500\nLine\n");
  assert.equal(toSrt(cues, () => "Строка"), "1\n01:02:03,045 --> 01:02:04,500\nСтрока\n");
  assert.equal(parseTimestamp("01:02:03,045"), 3723.045);
});

test("findCueAt finds the cue on screen, including overlaps and gaps", () => {
  const cues = [
    { start: 0, end: 10 },
    { start: 2, end: 3 },
    { start: 12, end: 14 },
  ];
  assert.equal(findCueAt(cues, 2.5), 1);
  assert.equal(findCueAt(cues, 5), 0); // second cue ended, first still showing
  assert.equal(findCueAt(cues, 11), -1);
  assert.equal(findCueAt(cues, 13), 2);
  assert.equal(findCueAt([], 1), -1);
});

test("a live line stays long enough to read: longer for longer lines, within limits", () => {
  assert.equal(readingTime("Привет!"), 6000, "short lines still get six seconds");
  assert.equal(readingTime("x".repeat(60)), 2500 + 110 * 60);
  assert.equal(readingTime("x".repeat(400)), 16000);
  assert.equal(readingTime("x".repeat(60), 2), 2 * (2500 + 110 * 60), "Settings can stretch it");
  assert.equal(readingTime("anything", Infinity), Infinity, "or keep lines until they are replaced");
  assert.equal(readingTime(""), 6000);
  assert.equal(readingTime(undefined), 6000);
});

test("live view: the newest line and the two before it, each until its time is up", () => {
  const at = (...expires) => expires.map((e) => ({ expires: e }));
  // A phrase is being spoken (null) under two finished ones that still have time.
  assert.deepEqual(liveView(at(900, 5000, 7000, null), 1000), { view: ["gone", "earlier", "earlier", "newest"], next: 5000 });
  // Their time passes one by one, from the top.
  assert.deepEqual(liveView(at(900, 5000, 7000, null), 5000).view, ["gone", "gone", "earlier", "newest"]);
  assert.deepEqual(liveView(at(900, 5000, 7000, null), 7000), { view: ["gone", "gone", "gone", "newest"], next: Infinity });
  // After the last phrase the screen clears too.
  assert.deepEqual(liveView(at(5000, 7000), 4000), { view: ["earlier", "newest"], next: 5000 });
  assert.deepEqual(liveView(at(5000, 7000), 6000), { view: ["gone", "newest"], next: 7000 });
  assert.deepEqual(liveView(at(5000, 7000), 7000).view, ["gone", "gone"]);
  // A short line under a long one doesn't leave first: no holes in the middle.
  assert.deepEqual(liveView(at(9000, 6000, null), 7000), { view: ["earlier", "earlier", "newest"], next: 9000 });
  // Fast speech: only the two lines before the newest stay, whatever time they have left.
  assert.deepEqual(liveView(at(9000, 9000, 9000, 9000, 9000), 0).view, ["gone", "gone", "earlier", "earlier", "newest"]);
  assert.deepEqual(liveView(at(9000, 9000, 9000), 0, 1).view, ["gone", "earlier", "newest"]);
  // "Until replaced": nothing clears on its own.
  assert.deepEqual(liveView(at(Infinity, Infinity), 1e9), { view: ["earlier", "newest"], next: Infinity });
  assert.deepEqual(liveView([], 0), { view: [], next: Infinity });
});
