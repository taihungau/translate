import { parseSubtitles, toSrt, findCueAt, readingTime, liveView } from "./subtitles.js";
import { LocalRecognizer } from "./local-asr.js";
import { CloudRecognizer } from "./cloud-asr.js";
import { pronounce, loadDictionary } from "./pronounce.js";

const $ = (id) => document.getElementById(id);

function storedCode() {
  try { return localStorage.getItem("accessCode") || ""; } catch { return ""; }
}

let askingForCode = null;
function askForCode() {
  // One prompt even when several requests fail at once.
  askingForCode ??= Promise.resolve().then(() => {
    const code = window.prompt("This translator is protected. Enter the access code:") || "";
    try { localStorage.setItem("accessCode", code); } catch { /* private mode */ }
    askingForCode = null;
    return code;
  });
  return askingForCode;
}

// A progress bar: pct 0-100, or null for "working, no percentage" (an animated bar).
// While any bar is showing, keep it on screen even when the controls are hidden.
const activeBars = new Set();
function syncDownloading() {
  document.body.classList.toggle("downloading", activeBars.size > 0);
}
function loadBar(id) {
  const el = $(id);
  const fill = el.querySelector("i");
  const label = el.querySelector(".loadbar-label");
  return {
    set(pct, text) {
      activeBars.add(id);
      syncDownloading();
      el.hidden = false;
      el.classList.toggle("indeterminate", pct == null);
      fill.style.width = pct == null ? "" : `${pct}%`;
      label.textContent = text;
    },
    done() {
      el.hidden = true;
      activeBars.delete(id);
      syncDownloading();
    },
  };
}
const mtBar = loadBar("mtLoad");
const asrBar = loadBar("asrLoad");

// ---------------------------------------------------------------- direction
// English → Russian or Russian → English. Speech recognition listens for the "from" language.
const NAMES = { en: "English", ru: "Russian" };
let direction = "en-ru";
try { if (localStorage.getItem("direction") === "ru-en") direction = "ru-en"; } catch { /* storage blocked */ }
const fromLang = () => direction.slice(0, 2);
const toLang = () => direction.slice(3);

function showDirection() {
  const from = fromLang();
  const to = toLang();
  $("dirFrom").textContent = from.toUpperCase();
  $("dirTo").textContent = to.toUpperCase();
  $("dirName").textContent = `${NAMES[from]} → ${NAMES[to]}`;
  $("direction").setAttribute("aria-label", `Translating ${NAMES[from]} to ${NAMES[to]}. Switch to ${NAMES[to]} to ${NAMES[from]}`);
  for (const el of document.querySelectorAll(".dir-from-name")) el.textContent = NAMES[from];
  for (const el of document.querySelectorAll(".dir-to-name")) el.textContent = NAMES[to];
}
showDirection();

$("direction").addEventListener("click", () => {
  direction = direction === "en-ru" ? "ru-en" : "en-ru";
  try { localStorage.setItem("direction", direction); } catch { /* storage blocked */ }
  showDirection();
  prepareEngine();
  if (engineSel.value === "opus") opusTranslate([], "load").catch(() => {});
  document.dispatchEvent(new Event("directionchange"));
});

// ---------------------------------------------------------------- pronunciation
// A line under each subtitle saying how to pronounce it in the other alphabet:
// Russian in Latin letters, English in Russian letters.
const saySwitch = { ru: $("sayRu"), en: $("sayEn") };
const sayChanged = () => document.dispatchEvent(new Event("saychange"));
for (const [lang, box] of Object.entries(saySwitch)) {
  try { box.checked = localStorage.getItem(`say-${lang}`) !== "0"; } catch { /* storage blocked */ }
  box.addEventListener("change", () => {
    try { localStorage.setItem(`say-${lang}`, box.checked ? "1" : "0"); } catch { /* storage blocked */ }
    if (lang === "en" && box.checked) loadDictionary().then(sayChanged);
    sayChanged();
  });
}
if (saySwitch.en.checked) loadDictionary().then(sayChanged);

/** How to pronounce `text` (in language `lang`), or "" when that hint is off. */
function sayFor(text, lang) {
  return saySwitch[lang].checked ? pronounce(text, lang) : "";
}
// The hint is written in the other alphabet, which screen readers need to know.
const SAY_LANG = { ru: "ru-Latn", en: "en-Cyrl" };

// ---------------------------------------------------------------- translation engines
// "chrome": Chrome's on-device Translator API (Chrome 138+ desktop). Free, no key, no server.
// "claude": POST /api/translate, which calls Claude with the server's ANTHROPIC_API_KEY.
const engineSel = $("engine");
const engineStatus = $("engineStatus");
const hasBuiltIn = "Translator" in self;

function setEngineStatus(text, isError = false) {
  engineStatus.textContent = text;
  engineStatus.classList.toggle("error", isError);
}

{
  let saved = "";
  try { saved = localStorage.getItem("engine") || ""; } catch { /* storage blocked */ }
  if (!hasBuiltIn) {
    // Phones, Safari, Firefox: Chrome's translator isn't there, the on-device model is.
    engineSel.querySelector('[value="chrome"]').disabled = true;
    engineSel.value = saved && saved !== "chrome" ? saved : "opus";
  } else {
    engineSel.value = saved || "chrome";
  }
  if (engineSel.value === "chrome") setEngineStatus("Free, runs on this computer");
  if (engineSel.value === "opus") setEngineStatus("Free; downloads ~80 MB the first time");
}

// On-device Opus-MT model in a worker (mt-worker.js).
let mtWorker = null;
let mtNextId = 0;
const mtPending = new Map();
function opusTranslate(texts, type = "translate") {
  if (!mtWorker) {
    mtWorker = new Worker(new URL("./mt-worker.js", import.meta.url), { type: "module" });
    mtWorker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        const pct = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
        const text = data.saved
          ? `Loading saved translation model… ${pct}%`
          : `Downloading the translation model (one time only)… ${pct}% · ${Math.round(data.loaded / 1e6)} of ${Math.round(data.total / 1e6)} MB`;
        setEngineStatus(text);
        mtBar.set(pct, text);
        return;
      }
      const job = mtPending.get(data.id);
      if (!job) return;
      mtPending.delete(data.id);
      mtBar.done();
      if (data.type === "result") {
        setEngineStatus("Free, runs on this device");
        job.resolve(data.texts);
      } else {
        setEngineStatus(data.message, true);
        job.reject(new Error(data.message));
      }
    };
  }
  const id = mtNextId++;
  return new Promise((resolve, reject) => {
    mtPending.set(id, { resolve, reject });
    mtWorker.postMessage({ type, id, texts, direction });
  });
}

async function createBuiltIn(dir) {
  const [from, to] = dir.split("-");
  const pair = { sourceLanguage: from, targetLanguage: to };
  const availability = await Translator.availability(pair);
  if (availability === "unavailable") {
    throw new Error(`Chrome can't translate ${NAMES[from]} to ${NAMES[to]} on this device. Switch to Claude.`);
  }
  const translator = await Translator.create({
    ...pair,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        const text = `Downloading Chrome's language pack… ${Math.round(e.loaded * 100)}%`;
        setEngineStatus(text);
        mtBar.set(Math.round(e.loaded * 100), text);
      });
    },
  });
  setEngineStatus("Free, runs on this computer");
  mtBar.done();
  return translator;
}

const builtIns = new Map(); // direction -> Promise<Translator>
function getBuiltIn(dir = direction) {
  if (!builtIns.has(dir)) {
    builtIns.set(dir, (async () => {
      setEngineStatus("Preparing Chrome's translator…");
      const slow = setTimeout(() => setEngineStatus(
        "Chrome's translator is still getting ready. If this doesn't finish, switch to Claude.", true), 20000);
      try {
        return await createBuiltIn(dir);
      } finally {
        clearTimeout(slow);
      }
    })().catch((err) => {
      builtIns.delete(dir);
      // The first download must start from a click; Start / choosing a file count as one.
      const msg = err?.name === "NotAllowedError"
        ? "Press Start (or choose the subtitle file again) to download Chrome's language pack."
        : err.message;
      setEngineStatus(msg, true);
      throw new Error(msg);
    }));
  }
  return builtIns.get(dir);
}

/** Call from a click handler so Chrome may download its language pack. */
export function prepareEngine() {
  if (engineSel.value === "chrome") getBuiltIn().catch(() => {});
}

engineSel.addEventListener("change", () => {
  try { localStorage.setItem("engine", engineSel.value); } catch { /* storage blocked */ }
  if (engineSel.value === "chrome") { setEngineStatus("Free, runs on this computer"); prepareEngine(); }
  else if (engineSel.value === "opus") setEngineStatus("Free; downloads ~80 MB the first time");
  else setEngineStatus("Uses the server's Anthropic API key");
});

// Short-lived Deepgram token from our server (the API key itself never reaches the browser).
async function getSpeechToken(retried = false) {
  const res = await fetch("/api/speech-token", { method: "POST", headers: { "X-Access-Code": storedCode() } });
  if (res.status === 401 && !retried && (await askForCode())) return getSpeechToken(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || `Couldn't start speech recognition (HTTP ${res.status})`);
  return data.token;
}

async function translate(lines, context = []) {
  const dir = direction;
  if (engineSel.value === "opus") {
    const texts = lines.map((l) => l.text.trim());
    const nonEmpty = texts.filter(Boolean);
    const out = nonEmpty.length ? await opusTranslate(nonEmpty) : [];
    let k = 0;
    return lines.map((l, i) => ({ id: l.id, text: texts[i] ? out[k++] ?? "" : "" }));
  }
  if (engineSel.value === "chrome") {
    const translator = await getBuiltIn(dir);
    return Promise.all(lines.map(async (l) => ({ id: l.id, text: l.text.trim() ? await translator.translate(l.text) : "" })));
  }
  return translateWithClaude(lines, context, dir);
}

async function translateWithClaude(lines, context, dir, retried = false) {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Code": storedCode() },
    body: JSON.stringify({ lines, context, direction: dir }),
  });
  if (res.status === 401 && !retried && (await askForCode())) return translateWithClaude(lines, context, dir, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.translations;
}

// iPhone Safari has no fullscreen for page elements, so fall back to stretching the element
// over the whole screen with CSS. Tapping the subtitle panel (or the player's button) exits.
function pseudoFullscreen(el, on) {
  el.classList.toggle("pseudo-fs", on);
  document.documentElement.classList.toggle("pseudo-fs-open", on);
}

function toggleFullscreen(el) {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  if (el.classList.contains("pseudo-fs")) return pseudoFullscreen(el, false);
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request || document.fullscreenEnabled === false) return pseudoFullscreen(el, true);
  Promise.resolve(request.call(el)).catch(() => pseudoFullscreen(el, true));
}

// Work offline once loaded (the cinema may have no signal).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => reg.update())
    .catch((err) => console.warn("Offline support unavailable:", err));
  // A new version was installed while this page was open: reload once to run it.
  let reloaded = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
}

// Ask the browser not to clear saved models when it tidies up storage.
async function keepModelsSaved() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- appearance
// Automatic follows the phone's light/dark setting. Full-screen (cinema) mode is always dark.
const themeSel = $("theme");
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const choice = themeSel.value;
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  const dark = document.body.classList.contains("immersive") || (choice ? choice === "dark" : darkQuery.matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#000000" : "#ffffff";
}
try { themeSel.value = localStorage.getItem("theme") || ""; } catch { /* storage blocked */ }
applyTheme();
themeSel.addEventListener("change", () => {
  try { localStorage.setItem("theme", themeSel.value); } catch { /* storage blocked */ }
  applyTheme();
});
darkQuery.addEventListener("change", applyTheme);
new MutationObserver(applyTheme).observe(document.body, { attributeFilter: ["class"] });

// ---------------------------------------------------------------- tabs
for (const tab of document.querySelectorAll(".tab[data-panel]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab[data-panel]")) {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", String(t === tab));
    }
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === tab.dataset.panel);
  });
}

// ---------------------------------------------------------------- live mode
(() => {
  const toggleBtn = $("liveToggle");
  const statusEl = $("liveStatus");
  const stage = $("liveStage");
  const feed = $("liveFeed"); // scrolls: the newest line at the bottom, earlier ones above it
  const linesEl = $("liveLines");
  const latestBtn = $("liveLatest");

  let listening = false;
  const recentLines = []; // what was said lately, as context for the translator

  // The transcript: one entry per spoken phrase, oldest first. While a phrase is still being
  // spoken we translate the partial text (rank 0, 1, 2...) so the translation appears
  // immediately; the final text gets rank Infinity. Translations finish out of order, so an
  // entry only takes one newer than it shows.
  const entries = [];
  let live = null; // the entry of the phrase being spoken, until its final text arrives
  let interimRank = 0;
  let phraseId = 0;
  let lastFinal = ""; // the phrase that finished last

  const MIN_INTERIM_WORDS = 2;
  const MAX_SUBTITLE_CHARS = 110;
  const KEEP_EARLIER = 2; // lines before the newest that stay on screen, dimmed (3 with more time on screen)
  const MAX_ENTRIES = 400; // about half an hour of dialogue to scroll back through
  const REVIEW_IDLE_MS = 15000; // looking back while the film runs: return to the newest line after this

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
  }

  function setToggle(on) {
    toggleBtn.classList.toggle("listening", on);
    toggleBtn.setAttribute("aria-label", on ? "Stop listening" : "Start listening");
    $("liveToggleLabel").textContent = on ? "Stop" : "Start";
    document.body.classList.toggle("listening", on);
    document.body.classList.remove("show-controls");
  }

  // ---- following the newest line, or looking back at earlier ones
  let following = true;
  let away = false; // while looking back: has the view left the newest line yet?
  let newLines = 0; // lines that arrived while looking back
  let reviewTimer = null;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const atBottom = () => feed.scrollHeight - feed.clientHeight - feed.scrollTop < 32;
  const toBottom = () => { feed.scrollTop = feed.scrollHeight; };

  function armReviewTimer() {
    clearTimeout(reviewTimer);
    if (!following && listening) reviewTimer = setTimeout(() => setFollowing(true), REVIEW_IDLE_MS);
  }

  function setFollowing(on) {
    if (following !== on) {
      following = on;
      away = false;
      newLines = 0;
      stage.classList.toggle("reviewing", !on);
      latestBtn.hidden = on;
      $("liveLatestLabel").textContent = "Latest";
      if (on) toBottom();
    }
    armReviewTimer();
  }

  // Every change to the transcript goes through here. While following, the newest line stays
  // where it is and the lines above glide up to make room.
  let glide = null;
  function change(mutate) {
    const anchor = following ? entries.at(-1)?.el : null;
    const before = anchor?.getBoundingClientRect().top;
    mutate();
    if (!following) return;
    toBottom();
    if (!anchor?.isConnected || reduceMotion.matches) return;
    const moved = before - anchor.getBoundingClientRect().top;
    if (moved < 1) return;
    const offset = glide ? new DOMMatrixReadOnly(getComputedStyle(linesEl).transform).m42 : 0;
    glide?.cancel();
    glide = linesEl.animate(
      [{ transform: `translateY(${offset + moved}px)` }, { transform: "translateY(0)" }],
      { duration: 280, easing: "cubic-bezier(.2, .8, .2, 1)" },
    );
    glide.onfinish = () => { glide = null; };
  }

  // Scrolling up (keys, a mouse wheel, a finger) looks back; reaching the end again follows.
  feed.addEventListener("scroll", () => {
    if (following) {
      if (!atBottom()) setFollowing(false);
      return;
    }
    armReviewTimer();
    if (!atBottom()) away = true;
    else if (away) setFollowing(true);
  }, { passive: true });
  // A swipe down also looks back when there is too little text to scroll; a swipe up at the end
  // returns to the newest line.
  let touchStartY = null;
  feed.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
    armReviewTimer();
  }, { passive: true });
  feed.addEventListener("touchmove", (e) => {
    if (touchStartY === null) return;
    const dy = e.touches[0].clientY - touchStartY;
    if (following && dy > 16 && entries.length) setFollowing(false);
    else if (!following && dy < -16 && atBottom()) setFollowing(true);
  }, { passive: true });
  feed.addEventListener("touchend", () => { touchStartY = null; }, { passive: true });
  feed.addEventListener("wheel", (e) => {
    if (following && e.deltaY < 0 && entries.length) setFollowing(false);
    else if (!following && e.deltaY > 0 && atBottom()) setFollowing(true);
    else armReviewTimer();
  }, { passive: true });
  latestBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // not a tap for the controls
    setFollowing(true);
  });
  // The newest line rests at a set height of the stage, whatever the screen and its rotation.
  const resized = new ResizeObserver(() => {
    stage.style.setProperty("--stage-h", `${stage.clientHeight}px`);
    if (following) toBottom();
  });
  resized.observe(stage);
  resized.observe(linesEl);

  // ---- the lines
  // Long run-on speech would fill the screen; keep the end, which is what is being said now.
  function tail(text) {
    if (text.length <= MAX_SUBTITLE_CHARS) return text;
    const cut = text.slice(-MAX_SUBTITLE_CHARS);
    return "…" + cut.slice(cut.indexOf(" ") + 1);
  }

  /** A new entry at the end, or just above `before`. */
  function addEntry(before = null) {
    const from = fromLang();
    const to = toLang();
    const line = (cls, lang, sayLang) => {
      const el = document.createElement("div");
      el.className = cls;
      const text = el.appendChild(document.createElement("div"));
      text.className = "sub-text";
      text.lang = lang;
      const say = el.appendChild(document.createElement("div"));
      say.className = "say";
      say.lang = sayLang; // written in the other alphabet, which screen readers need to know
      return { el, text, say };
    };
    const entry = {
      el: document.createElement("div"),
      orig: line("sub-orig", from, SAY_LANG[from]), // what was said (smaller)
      trans: line("sub-trans", to, SAY_LANG[to]), // its translation (large)
      from,
      to,
      original: "",
      interim: "",
      translated: "",
      rank: -1,
      since: null, // when its final translation appeared: its reading time runs from then
      cleared: false,
    };
    entry.el.className = "entry";
    entry.el.append(entry.orig.el, entry.trans.el);
    change(() => {
      const at = before ? entries.indexOf(before) : -1;
      if (at >= 0) {
        entries.splice(at, 0, entry);
        linesEl.insertBefore(entry.el, before.el);
      } else {
        const previous = entries.at(-1);
        entries.push(entry);
        linesEl.append(entry.el);
        if (previous) render(previous); // no longer the newest
      }
      // Trim only while following: removing lines above someone's reading place would move it.
      while (following && entries.length > MAX_ENTRIES) entries.shift().el.remove();
      stage.classList.remove("empty");
      refresh();
    });
    if (!following) {
      newLines++;
      $("liveLatestLabel").textContent = newLines === 1 ? "1 new line" : `${newLines} new lines`;
    }
    return entry;
  }

  // The newest entry stays compact: the end of a long sentence, and how to pronounce it. Once
  // it has moved up it shows the whole sentence, without the pronunciation.
  function render(entry) {
    const newest = entry === entries.at(-1);
    const cut = newest ? tail : (text) => text;
    entry.orig.text.textContent = cut(entry.original);
    if (entry.interim) {
      const span = document.createElement("span");
      span.className = "interim";
      span.textContent = (entry.original ? " " : "") + cut(entry.interim);
      entry.orig.text.append(span);
    }
    entry.trans.text.textContent = cut(entry.translated);
    entry.orig.say.textContent = newest ? sayFor(entry.orig.text.textContent, entry.from) : "";
    entry.trans.say.textContent = newest && entry.translated ? sayFor(entry.trans.text.textContent, entry.to) : "";
  }
  document.addEventListener("saychange", () => {
    const newest = entries.at(-1);
    if (newest) change(() => render(newest));
  });

  function showTranslation(entry, rank, translated) {
    if (!translated || rank <= entry.rank || !entry.el.isConnected) return;
    entry.rank = rank;
    entry.translated = translated;
    change(() => render(entry));
  }

  // Which lines are on screen: the newest and the two before it, each until there has been time
  // to read it (subtitles.js). Looking back shows all of them.
  let keepFactor = 1; // Settings → Time on screen
  let refreshTimer = null;
  function refresh() {
    clearTimeout(refreshTimer);
    const now = performance.now();
    const keep = keepFactor > 1 ? KEEP_EARLIER + 1 : KEEP_EARLIER;
    const recent = entries.slice(-(keep + 4));
    const { view, next } = liveView(recent.map((e) => ({
      expires: e.cleared ? 0 : e.since === null ? null : e.since + readingTime(e.translated || e.original, keepFactor),
    })), now, keep);
    recent.forEach((e, i) => {
      e.el.classList.toggle("newest", view[i] === "newest");
      e.el.classList.toggle("gone", view[i] === "gone");
      e.el.classList.toggle("last", e === entries.at(-1));
    });
    if (next < Infinity) refreshTimer = setTimeout(refresh, Math.max(50, next - now + 20));
  }
  /** A line's reading time starts when its final translation appears (or fails to). */
  function startClock(entry) {
    entry.since = performance.now();
    refresh();
  }

  // Partial text: translate the latest version, never queue up stale ones.
  let interimBusy = false;
  let interimNext = null;
  async function translateInterim(text) {
    interimNext = { entry: live, rank: interimRank++, text };
    if (interimBusy) return;
    interimBusy = true;
    while (interimNext) {
      const job = interimNext;
      interimNext = null;
      try {
        const [result] = await translate([{ id: "interim", text: job.text }], recentLines.slice(-6));
        if (job.entry === live) showTranslation(job.entry, job.rank, result?.text);
      } catch { /* the final translation will report errors */ }
    }
    interimBusy = false;
  }

  function handleInterim(interim) {
    // The on-device recogniser repeats the sentence finished last before the live words; here
    // that sentence has its own line already.
    if (!useCloud && lastFinal && interim.startsWith(lastFinal)) interim = interim.slice(lastFinal.length).trim();
    if (!interim || !listening) return; // words still arriving after Stop are dropped
    live ??= addEntry();
    const entry = live;
    entry.interim = interim;
    change(() => render(entry));
    // Partial translations are free with the on-device translators. With Claude each one
    // would be a paid request, so Claude only translates finished phrases.
    if (engineSel.value !== "claude" && interim.split(/\s+/).length >= MIN_INTERIM_WORDS) {
      translateInterim(interim);
    }
  }

  // Finished phrases are kept on this device for the course's "Из фильмов" (from films) review.
  function rememberPhrase(original, translated) {
    if (!translated) return;
    const [en, ru] = fromLang() === "en" ? [original, translated] : [translated, original];
    if (en.trim().split(/\s+/).length < 2 || en.length > 140) return;
    try {
      const list = JSON.parse(localStorage.getItem("heardPhrases") || "[]").filter((h) => h.en !== en);
      list.push({ en, ru, at: Date.now() });
      localStorage.setItem("heardPhrases", JSON.stringify(list.slice(-200)));
    } catch { /* storage full or blocked */ }
  }

  async function addPhrase(text, { show: display = true } = {}) {
    const context = recentLines.slice(-6);
    recentLines.push(text);
    if (recentLines.length > 20) recentLines.shift();
    lastFinal = text;
    let entry;
    if (display) {
      entry = live ?? addEntry();
      live = null;
      interimNext = null;
    } else {
      // The on-device recogniser finished this sentence after newer words were already on
      // screen: it gets its own line just above them.
      entry = addEntry(live);
    }
    entry.original = text;
    entry.interim = "";
    change(() => render(entry));
    try {
      const [result] = await translate([{ id: String(phraseId++), text }], context);
      showTranslation(entry, Infinity, result?.text);
      rememberPhrase(text, result?.text);
      if (listening) setStatus("Listening…");
    } catch (err) {
      setStatus(err.message, true);
    }
    startClock(entry);
  }

  const local = new LocalRecognizer({
    onInterim: (text) => handleInterim(text),
    onFinal: (text, opts) => addPhrase(text, opts),
    onError: (message) => setStatus(message, true),
    onProgress: ({ pct, text }) => asrBar.set(pct, text),
    onTiming: (ms) => {
      if (listening && !statusEl.classList.contains("error")) setStatus(`Listening · Whisper ~${(ms / 1000).toFixed(1)} s per update`);
    },
  });
  // Load (and the first time, download) the model as soon as the page opens.
  function loadModel() {
    return local.load().then(
      () => {
        asrBar.done();
        if (!listening) setStatus("Ready. Press Start.");
      },
      (err) => {
        asrBar.done();
        setStatus(err.message, true);
        throw err;
      },
    );
  }

  // Best quality, any device: Deepgram Nova-3 in the cloud when the server has a key.
  // Otherwise Whisper Large v3 Turbo on this computer.
  const cloud = new CloudRecognizer({
    onInterim: (text) => handleInterim(text),
    onFinal: (text, opts) => addPhrase(text, opts),
    onError: (message) => {
      setStatus(message, true);
      stop();
    },
    onStatus: (text) => {
      if (listening) setStatus(text);
    },
  }, getSpeechToken);
  let useCloud = false;
  const speechReady = fetch("/api/config", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { error: `HTTP ${r.status}` }))
    .catch((err) => ({ error: err.message }))
    .then((cfg) => {
      useCloud = Boolean(cfg.cloudSpeech);
      $("appVersion").textContent = useCloud ? "v10 · Deepgram Nova-3" : "v10 · on-device Whisper (no Deepgram key)";
      if (useCloud) {
        setStatus("Ready. Press Start.");
      } else if (cfg.error) {
        setStatus(`Couldn't ask the server which speech recognition to use (${cfg.error}). Pressing Start uses on-device Whisper (1.3 GB download).`, true);
      } else {
        // Don't start a big download unasked: say why Deepgram isn't being used.
        setStatus(`The server has no Deepgram key (${cfg.environment || "?"} deployment). In Vercel add DEEPGRAM_API_KEY for Production, then redeploy. Pressing Start now uses on-device Whisper instead (1.3 GB download).`, true);
      }
    });
  const micSel = $("liveMic");
  const levelEl = $("liveLevel");
  let micStream = null;
  let micTrack = null;
  let stopMeter = null;

  async function listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    let saved = micSel.value;
    try { saved ||= localStorage.getItem("liveMic") || ""; } catch { /* storage blocked */ }
    micSel.replaceChildren(new Option("Default", ""));
    mics.forEach((d, i) => {
      if (d.deviceId === "default" || d.deviceId === "") return;
      micSel.append(new Option(d.label || `Microphone ${i + 1}`, d.deviceId));
    });
    const has = (id) => [...micSel.options].some((o) => o.value === id);
    // First time: prefer the computer's own microphone (e.g. "MacBook Pro Microphone") over
    // whatever the system default happens to be (AirPods, an iPhone, a webcam).
    const builtIn = mics.find((d) => /macbook|built-in|internal/i.test(d.label));
    micSel.value = has(saved) ? saved : builtIn && has(builtIn.deviceId) ? builtIn.deviceId : "";
  }
  listMics();
  navigator.mediaDevices?.addEventListener?.("devicechange", listMics);

  // Shows whether the microphone actually hears the film.
  function startMeter(stream) {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {}); // may start suspended when created after the permission prompt
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let raf;
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      levelEl.style.width = `${Math.min(100, rms * 400)}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); ctx.close(); levelEl.style.width = "0"; };
  }

  const boostSel = $("liveBoost");
  // Too much boost distorts the sound, and Whisper invents words from distorted audio.
  try { boostSel.value = localStorage.getItem("liveBoost") || "2"; } catch { /* storage blocked */ }
  if (!boostSel.value) boostSel.value = "2"; // e.g. a saved 8× from an earlier version
  let rawStream = null;
  let boostGraph = null;

  // Mic boost: gain, then a compressor so loud effects don't clip while quiet dialogue is
  // lifted. Every recogniser and the level meter use the boosted signal.
  function boost(stream) {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = Number(boostSel.value) || 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -28;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    // Limiter: a loud scene must never clip, distorted audio is what hurts recognition most.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    const out = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(stream).connect(gain).connect(comp).connect(limiter).connect(out);
    return { ctx, gain, stream: out.stream };
  }

  async function openMic() {
    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(micSel.value ? { deviceId: { exact: micSel.value } } : {}),
        // Video-call clean-up treats film dialogue as background noise and removes it.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    boostGraph = boost(rawStream);
    micStream = boostGraph.stream;
    micTrack = micStream.getAudioTracks()[0];
    stopMeter = startMeter(micStream);
    listMics(); // device names are only available after permission is granted
  }

  function closeMic() {
    stopMeter?.();
    stopMeter = null;
    rawStream?.getTracks().forEach((t) => t.stop());
    boostGraph?.ctx.close().catch(() => {});
    rawStream = micStream = micTrack = boostGraph = null;
  }

  async function start() {
    prepareEngine();
    keepModelsSaved();
    listening = true;
    live = null; // a phrase cut off by the last Stop is over
    armReviewTimer();
    setToggle(true);
    keepAwake();
    setStatus("Starting microphone…");
    try {
      await openMic();
    } catch (err) {
      setStatus(err?.name === "NotAllowedError" ? "Microphone access was denied." : `Couldn't open the microphone: ${err.message}`, true);
      stop();
      return;
    }
    if (!listening) return closeMic();
    if (!micStream) {
      setStatus("Couldn't open the microphone.", true);
      stop();
      return;
    }
    try {
      await speechReady;
      if (useCloud) {
        setStatus("Connecting…");
        await cloud.start(micStream, fromLang());
        if (listening) setStatus("Listening (Deepgram Nova-3)…");
        return;
      }
      setStatus("Loading the speech model…");
      await loadModel();
      if (!listening) return;
      await local.start(micStream, fromLang());
      setStatus("Listening…");
    } catch (err) {
      setStatus(err.message, true);
      stop();
    }
  }

  function stop() {
    listening = false;
    clearTimeout(reviewTimer); // stopped: stay wherever the reader is
    if (live) startClock(live); // the phrase being spoken won't be finished
    local.stop();
    cloud.stop();
    closeMic();
    setToggle(false);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    if (!statusEl.classList.contains("error")) setStatus("Stopped");
  }

  if (engineSel.value === "opus") opusTranslate([], "load").catch(() => {});

  boostSel.addEventListener("change", () => {
    try { localStorage.setItem("liveBoost", boostSel.value); } catch { /* storage blocked */ }
    if (boostGraph) boostGraph.gain.gain.value = Number(boostSel.value) || 1;
  });
  micSel.addEventListener("change", async () => {
    try { localStorage.setItem("liveMic", micSel.value); } catch { /* storage blocked */ }
    if (!listening) return;
    stop();
    await start();
  });

  toggleBtn.addEventListener("click", () => (listening ? stop() : start()));

  // Swapping languages: clear the screen and listen for the other language.
  document.addEventListener("directionchange", async () => {
    live = null;
    interimNext = null;
    recentLines.length = 0;
    lastFinal = "";
    // A clean screen for the other language; what was said is still there when scrolling up.
    for (const e of entries.slice(-(KEEP_EARLIER + 2))) e.cleared = true;
    refresh();
    if (!listening) return;
    stop();
    await start();
  });
  // Stop phones and laptops dimming or locking the screen mid-film.
  let wakeLock = null;
  async function keepAwake() {
    try {
      wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch { /* not supported or refused (e.g. low battery) */ }
  }
  // The lock is released whenever the page is hidden; take it again when it comes back.
  document.addEventListener("visibilitychange", () => {
    if (listening && document.visibilityState === "visible") keepAwake();
  });

  const sizeSel = $("liveSize");
  const applySize = () => stage.style.setProperty("--sub-scale", sizeSel.value);
  try { sizeSel.value = localStorage.getItem("liveSize") || "1"; } catch { /* storage blocked */ }
  if (!sizeSel.value) sizeSel.value = "1";
  applySize();
  sizeSel.addEventListener("change", () => {
    try { localStorage.setItem("liveSize", sizeSel.value); } catch { /* storage blocked */ }
    applySize();
  });
  $("liveShowOrig").addEventListener("change", (e) => stage.classList.toggle("hide-orig", !e.target.checked));
  // How long lines stay: normal reading time, twice that, or until newer lines replace them.
  const keepSel = $("liveKeep");
  const applyKeep = () => {
    keepFactor = keepSel.value === "always" ? Infinity : Number(keepSel.value) || 1;
    refresh();
  };
  try { keepSel.value = localStorage.getItem("liveKeep") || "1"; } catch { /* storage blocked */ }
  if (!keepSel.value) keepSel.value = "1";
  applyKeep();
  keepSel.addEventListener("change", () => {
    try { localStorage.setItem("liveKeep", keepSel.value); } catch { /* storage blocked */ }
    applyKeep();
  });
  // Full screen (cinema mode): only the subtitles stay on screen. Where the browser allows it
  // (Android, computers) the page also enters real full screen; iPhone Safari doesn't allow
  // that for web pages, so there the app hides its own controls and suggests Add to Home Screen.
  const root = document.documentElement;
  const canRealFullscreen = Boolean(root.requestFullscreen || root.webkitRequestFullscreen) && document.fullscreenEnabled !== false;
  const inRealFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  function enterCinema() {
    document.body.classList.add("immersive");
    if (canRealFullscreen && !inRealFullscreen()) {
      Promise.resolve((root.requestFullscreen || root.webkitRequestFullscreen).call(root)).catch(() => {});
    }
    showControlsBriefly();
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    let tipShown = false;
    try { tipShown = localStorage.getItem("a2hsTip") === "1"; } catch { /* storage blocked */ }
    if (isIOS && !navigator.standalone && !tipShown) {
      toast("Tip: for true full screen, tap Share → Add to Home Screen and open Subtitles from there.");
      try { localStorage.setItem("a2hsTip", "1"); } catch { /* storage blocked */ }
    }
  }
  function exitCinema() {
    document.body.classList.remove("immersive", "show-controls");
    if (inRealFullscreen()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  const toggleCinema = () => (document.body.classList.contains("immersive") ? exitCinema() : enterCinema());
  $("liveFullscreen").addEventListener("click", toggleCinema);
  $("cinemaBtn").addEventListener("click", enterCinema);
  $("exitCinema").addEventListener("click", (e) => {
    e.stopPropagation();
    exitCinema();
  });
  // Leaving real full screen with Esc or a swipe also leaves cinema mode.
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => {
      if (!inRealFullscreen()) document.body.classList.remove("immersive", "show-controls");
    });
  }

  let toastTimer = null;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  // While listening the controls fade away; tapping the screen shows them for a few seconds.
  let controlsTimer = null;
  function showControlsBriefly() {
    document.body.classList.add("show-controls");
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => document.body.classList.remove("show-controls"), 4000);
  }
  stage.addEventListener("click", () => {
    if (listening || document.body.classList.contains("immersive")) showControlsBriefly();
  });

  // Settings sheet
  const settings = $("settings");
  $("openSettings").addEventListener("click", () => settings.showModal());
  $("closeSettings").addEventListener("click", () => settings.close());
  settings.addEventListener("click", (e) => {
    if (e.target === settings) settings.close(); // tap outside the sheet
  });
})();

// ---------------------------------------------------------------- video + subtitle file mode
(() => {
  const video = $("videoEl");
  const overlay = $("overlay");
  const progressEl = $("subProgress");
  const statusEl = $("subStatus");
  const modeSel = $("subMode");
  const downloadBtn = $("downloadSrt");

  const CONCURRENCY = 3;
  const FIRST_BATCH = 8; // small first batch so subtitles appear quickly
  const BATCH = 25;
  const MAX_ATTEMPTS = 3;

  let cues = [];
  let fileName = "subtitles";
  let generation = 0; // bumps when a new file is loaded, to drop stale responses
  let inFlight = 0;
  let lastError = "";
  let renderedKey = "";

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
  }

  function updateProgress() {
    const done = cues.filter((c) => c.tr !== undefined).length;
    progressEl.max = cues.length || 1;
    progressEl.value = done;
    const failed = cues.filter((c) => c.tr === undefined && c.attempts >= MAX_ATTEMPTS).length;
    if (!cues.length) setStatus("No subtitles loaded");
    else if (done === cues.length) setStatus(`All ${cues.length} subtitles translated`);
    else if (failed && !inFlight) setStatus(`${done}/${cues.length} translated, ${failed} failed: ${lastError}`, true);
    else setStatus(`Translating… ${done}/${cues.length}`);
    downloadBtn.disabled = done === 0;
    $("downloadLabel").textContent = done === cues.length || !cues.length ? `Download ${NAMES[toLang()]} .srt` : "Download partial .srt";
  }

  const needsWork = (c) => c.tr === undefined && !c.pending && c.attempts < MAX_ATTEMPTS && Date.now() >= c.retryAt;

  // Translate outward from the playhead: first what is on screen now and just
  // ahead, then the rest of the file after it, then anything before it.
  function nextBatch() {
    if (!cues.length) return null;
    const t = video.currentTime || 0;
    let from = findCueAt(cues, t);
    if (from === -1) {
      from = cues.findIndex((c) => c.start >= t);
      if (from === -1) from = 0;
    }
    const order = [...cues.slice(from), ...cues.slice(0, from)];
    const firstIdx = order.findIndex(needsWork);
    if (firstIdx === -1) return null;
    const size = cues.some((c) => c.tr !== undefined) ? BATCH : FIRST_BATCH;
    const batch = [];
    // Keep batches contiguous so each one reads like a scene.
    for (let i = firstIdx; i < order.length && batch.length < size; i++) {
      if (!needsWork(order[i])) break;
      batch.push(order[i]);
    }
    return batch;
  }

  function pump() {
    while (inFlight < CONCURRENCY) {
      const batch = nextBatch();
      if (!batch) break;
      runBatch(batch);
    }
    // Retry backed-off cues later.
    if (!inFlight && cues.some((c) => c.tr === undefined && c.attempts < MAX_ATTEMPTS)) setTimeout(pump, 1000);
  }

  async function runBatch(batch) {
    const gen = generation;
    inFlight++;
    for (const c of batch) c.pending = true;
    const firstIndex = cues.indexOf(batch[0]);
    const context = cues.slice(Math.max(0, firstIndex - 4), firstIndex).map((c) => c.text);
    try {
      const results = await translate(batch.map((c) => ({ id: c.id, text: c.text })), context);
      if (gen !== generation) return;
      const byId = new Map(results.map((r) => [r.id, r.text]));
      for (const c of batch) {
        if (byId.has(c.id)) c.tr = byId.get(c.id);
        else c.attempts++;
      }
    } catch (err) {
      if (gen !== generation) return;
      lastError = err.message;
      for (const c of batch) {
        c.attempts++;
        c.retryAt = Date.now() + 1500 * c.attempts;
      }
    } finally {
      if (gen === generation) {
        for (const c of batch) c.pending = false;
        inFlight--;
        renderedKey = "";
        updateProgress();
        pump();
      }
    }
  }

  function render() {
    const idx = findCueAt(cues, video.currentTime);
    const cue = cues[idx];
    const mode = modeSel.value;
    const key = `${idx}|${mode}|${cue?.tr !== undefined}|${direction}`;
    if (key !== renderedKey) {
      renderedKey = key;
      overlay.replaceChildren();
      if (cue) {
        const addLine = (text, cls) => {
          const div = document.createElement("div");
          const span = document.createElement("span");
          span.className = `line ${cls}`;
          span.textContent = text;
          div.append(span);
          overlay.append(div);
          return span;
        };
        const addSay = (text, lang) => {
          const say = sayFor(text, lang);
          if (say) addLine(say, "say").lang = SAY_LANG[lang];
        };
        // The mode values predate the language swap: "ru" = translation only, "en" = original only.
        if (mode !== "en") {
          if (cue.tr !== undefined) {
            addLine(cue.tr, "ru").lang = toLang();
            addSay(cue.tr, toLang());
          } else if (cue.attempts >= MAX_ATTEMPTS) addLine(cue.text, "ru");
          else addLine(toLang() === "ru" ? "перевод…" : "translating…", "wait");
        }
        if (mode !== "ru") {
          addLine(cue.text, "en").lang = fromLang();
          addSay(cue.text, fromLang());
        }
      }
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  $("videoFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
  });

  $("subFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    prepareEngine();
    const parsed = parseSubtitles(await file.text());
    fileName = file.name.replace(/\.(srt|vtt)$/i, "").replace(/[._-](en|eng|english|ru|rus|russian)$/i, "");
    startTranslating(parsed);
    if (!cues.length) setStatus("No subtitles found in that file", true);
  });

  // (Re)translate every cue from scratch, e.g. after the languages are swapped.
  function startTranslating(parsed) {
    generation++;
    inFlight = 0;
    renderedKey = "";
    cues = parsed.map((c) => ({ ...c, tr: undefined, pending: false, attempts: 0, retryAt: 0 }));
    updateProgress();
    pump();
  }
  document.addEventListener("directionchange", () => {
    if (cues.length) startTranslating(cues.map(({ id, start, end, text }) => ({ id, start, end, text })));
    else updateProgress();
  });
  document.addEventListener("saychange", () => (renderedKey = ""));

  // Seeking changes which cues are most urgent; pump() reads currentTime each time.
  video.addEventListener("seeked", pump);
  modeSel.addEventListener("change", () => (renderedKey = ""));
  $("playerFullscreen").addEventListener("click", () => toggleFullscreen($("player")));

  downloadBtn.addEventListener("click", () => {
    const srt = toSrt(cues, (c) => c.tr ?? c.text);
    const url = URL.createObjectURL(new Blob([srt], { type: "application/x-subrip;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${fileName}.${toLang()}.srt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
