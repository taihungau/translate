// SRT / WebVTT parsing and SRT serialisation. Shared by the browser app and the tests.

const TIME_RE = /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

export function parseTimestamp(value) {
  const m = TIME_RE.exec(value.trim());
  if (!m) return NaN;
  const hours = m[1] ? Number(m[1].slice(0, -1)) : 0;
  return hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

export function formatSrtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** Parse SRT or WebVTT text into [{id, start, end, text}] sorted by start time. */
export function parseSubtitles(raw) {
  const blocks = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue; // WEBVTT header, NOTE, STYLE, etc.
    const [startRaw, endRaw] = lines[timeIdx].split("-->");
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw.trim().split(/\s+/)[0]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const text = lines
      .slice(timeIdx + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "") // strip <i>, <font>, VTT voice tags
      .replace(/\{\\[^}]*\}/g, "") // strip ASS-style {\an8} overrides
      .trim();
    if (!text) continue;
    cues.push({ id: String(cues.length + 1), start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function toSrt(cues, pickText = (c) => c.text) {
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${pickText(c)}\n`)
    .join("\n");
}

/** Index of the cue showing at time t, or -1. Cues must be sorted by start. */
export function findCueAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // With overlapping cues the latest-started one may already be gone while an
  // earlier, longer one is still on screen, so look back a few cues.
  for (let i = found; i >= 0 && i >= found - 5; i--) {
    if (cues[i].end > t) return i;
  }
  return -1;
}
