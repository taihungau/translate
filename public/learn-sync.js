// Course progress saved under a personal code (K7QM-4TZP-9HXW), so it follows a person to any
// device. The same merge runs on the server (combining what is stored with what a device sends)
// and on the device (keeping anything done while a save was on its way).
import { INTERVALS } from "./learn-core.js";

/** What is saved: cards (spaced repetition), test and exercise results, and the daily goal. */
export const SYNC_KEYS = ["learnProgress", "learnTests", "learnSkills", "learnStats"];
/** Codes use letters and digits that can't be mistaken for each other (no 0/O, 1/I/L). */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** "k7qm 4tzp-9hxw" → "K7QM-4TZP-9HXW", or null when it isn't a code. */
export function normalizeCode(text) {
  const s = String(text ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length !== 12 || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

const SYNC_DAY = 24 * 60 * 60 * 1000;
const SYNC_MAX_CARDS = 5000;
const SYNC_LESSON = /^[a-z0-9-]{1,64}$/;
const SYNC_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SYNC_SKILLS = ["listen", "read", "speak"];
const syncIsObject = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const syncIsInt = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
const syncKeys = (x) => (syncIsObject(x) ? Object.keys(x) : []);

function syncCardState(s) {
  return syncIsObject(s) && syncIsInt(s.box, INTERVALS.length - 1) && Number.isFinite(s.due) ? { box: s.box, due: s.due } : null;
}
// When the card was last answered: its due date minus the wait for its box.
const syncReviewedAt = (s) => s.due - INTERVALS[s.box] * SYNC_DAY;

function syncResult(r) {
  if (!syncIsObject(r) || !syncIsInt(r.best, 100) || !syncIsInt(r.total, 100) || r.best > r.total) return null;
  return { best: r.best, last: syncIsInt(r.last, r.total) ? r.last : r.best, total: r.total, at: Number.isFinite(r.at) ? r.at : 0 };
}
function syncMergeResult(a, b) {
  const x = syncResult(a);
  const y = syncResult(b);
  if (!x || !y) return x ?? y;
  const newer = y.at >= x.at ? y : x;
  return { ...newer, best: Math.max(x.best, y.best) };
}

/**
 * Combines two copies of someone's progress. Each card keeps its latest answer (so a phrase
 * forgotten on one phone is reviewed again there too); a test or exercise keeps its best score and
 * its latest try; each day keeps the larger card count. The daily goal comes from `newer`.
 * Anything malformed is dropped, so what is stored is always clean.
 */
export function mergeProgress(older = {}, newer = {}) {
  const a = syncIsObject(older) ? older : {};
  const b = syncIsObject(newer) ? newer : {};

  const learnProgress = {};
  let count = 0;
  for (const source of [a.learnProgress, b.learnProgress]) {
    for (const phrase of syncKeys(source)) {
      const s = syncCardState(source[phrase]);
      if (!s || phrase.length > 300 || phrase === "__proto__") continue;
      const have = learnProgress[phrase];
      if (!have && count >= SYNC_MAX_CARDS) continue;
      if (!have) count++;
      if (!have || syncReviewedAt(s) > syncReviewedAt(have) || (syncReviewedAt(s) === syncReviewedAt(have) && s.box > have.box)) learnProgress[phrase] = s;
    }
  }

  const learnTests = {};
  for (const id of new Set([...syncKeys(a.learnTests), ...syncKeys(b.learnTests)])) {
    if (!SYNC_LESSON.test(id)) continue;
    const r = syncMergeResult(a.learnTests?.[id], b.learnTests?.[id]);
    if (r) learnTests[id] = r;
  }

  const learnSkills = {};
  for (const id of new Set([...syncKeys(a.learnSkills), ...syncKeys(b.learnSkills)])) {
    if (!SYNC_LESSON.test(id)) continue;
    const lesson = {};
    for (const kind of SYNC_SKILLS) {
      const r = syncMergeResult(a.learnSkills?.[id]?.[kind], b.learnSkills?.[id]?.[kind]);
      if (r) lesson[kind] = r;
    }
    if (Object.keys(lesson).length) learnSkills[id] = lesson;
  }

  const days = {};
  for (const source of [a.learnStats?.days, b.learnStats?.days]) {
    for (const day of syncKeys(source)) {
      if (SYNC_DAY_KEY.test(day) && syncIsInt(source[day], 100000)) days[day] = Math.max(days[day] ?? 0, source[day]);
    }
  }
  for (const day of Object.keys(days).sort().slice(0, -400)) delete days[day]; // a year is plenty
  const goal = [b.learnStats?.goal, a.learnStats?.goal].find((g) => [5, 10, 20].includes(g)) ?? 10;

  return { learnProgress, learnTests, learnSkills, learnStats: { goal, days } };
}
