import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseSubtitles, toSrt, findCueAt, parseTimestamp } from "../public/subtitles.js";

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
