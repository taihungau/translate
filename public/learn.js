// The Learn page: an English course for a Russian speaker. Course → unit (goal, grammar,
// phrases) → practice cards → a written test, with a daily goal and a streak. In the subtitles
// app, phrases are read aloud by Deepgram's American voices, the speaking check listens with the
// same speech recognition as live subtitles, and sentences she writes herself are checked by Claude.
import { TRACKS, LEVELS, LESSONS } from "./lessons.js";
import { compareSpeech, checkWriting, testQuestions, choices, grade, isLearned, isDue, verdict, dayKey, streak } from "./learn-core.js";

const APP_URL = "https://translate-hyperlinks-projects.vercel.app/";
const view = document.getElementById("view");
const foot = document.getElementById("foot");

// ---------------------------------------------------------------- wallpaper
// A landscape behind frosted-glass panels, like an iPhone's Home Screen. "Авто" changes with the
// time of day: dawn in the morning, the lake by day, sunset in the evening, dusk at night.
const BACKDROP_DIR = globalThis.LEARN_BACKDROPS ?? "backgrounds/";
const BACKDROPS = [
  { id: "auto", label: "Авто" },
  { id: "lake-dawn", label: "Рассвет", pos: "47% 50%", top: "#b7c0c7" },
  { id: "lake-day", label: "День", pos: "48% 50%", top: "#91b8c8" },
  { id: "lake-sunset", label: "Закат", pos: "50% 50%", top: "#53595b" },
  { id: "lake-dusk", label: "Сумерки", pos: "48% 50%", top: "#5f576b" },
  { id: "mountains", label: "Горы", pos: "62% 50%", top: "#818a8a" },
  { id: "none", label: "Без фона" },
];
const backdropEl = document.getElementById("backdrop");
let backdropChoice = BACKDROPS.some((b) => b.id === load("learnBackdrop", "auto")) ? load("learnBackdrop", "auto") : "auto";

function backdropFor(choice, date = new Date()) {
  if (choice !== "auto") return BACKDROPS.find((b) => b.id === choice);
  const hour = date.getHours();
  const id = hour < 5 || hour >= 21 ? "lake-dusk" : hour < 10 ? "lake-dawn" : hour < 17 ? "lake-day" : "lake-sunset";
  return BACKDROPS.find((b) => b.id === id);
}

let shownBackdrop = null;
function applyBackdrop() {
  const backdrop = backdropFor(backdropChoice);
  const on = backdrop.id !== "none";
  document.documentElement.classList.toggle("has-backdrop", on);
  if (on && shownBackdrop !== backdrop.id && backdropEl) {
    const url = `${BACKDROP_DIR}${backdrop.id}.webp`;
    const img = new Image();
    img.onload = () => {
      if (backdropFor(backdropChoice).id !== backdrop.id) return; // another one was picked meanwhile
      backdropEl.style.backgroundImage = `url("${url}")`;
      backdropEl.style.backgroundPosition = backdrop.pos;
      backdropEl.classList.add("ready");
    };
    img.src = url;
  }
  shownBackdrop = on ? backdrop.id : null;
  matchBrowserBar();
}

// The browser bar matches the page: the wallpaper's sky, or the theme's background.
// (The theme follows the phone unless Appearance is set in the app.)
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function matchBrowserBar() {
  const theme = document.documentElement.dataset.theme;
  const dark = theme ? theme === "dark" : darkQuery.matches;
  const backdrop = backdropFor(backdropChoice);
  const color = backdrop.top ?? (dark ? "#000000" : "#f2f2f7");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}
darkQuery.addEventListener("change", () => { matchBrowserBar(); refreshThemeToggle(); });

// Light or dark. "Авто" follows the phone (or the app showing the page); a choice is saved under
// the same key as the subtitles app's Appearance setting, so both look the same.
const THEMES = [["", "Авто", "sun-moon"], ["light", "Светлая", "sun"], ["dark", "Тёмная", "moon"]];
function themeChoice() {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "";
  } catch {
    return "";
  }
}
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : darkQuery.matches;
}
function setTheme(choice) {
  const root = document.documentElement;
  try { localStorage.setItem("theme", choice); } catch { /* storage blocked: still applies until reload */ }
  if (choice) root.dataset.theme = choice;
  else if (root.dataset.autoTheme) root.dataset.theme = root.dataset.autoTheme; // what the page was given
  else delete root.dataset.theme;
  matchBrowserBar();
  for (const chip of document.querySelectorAll(".theme-choice .chip")) chip.setAttribute("aria-checked", String(chip.dataset.theme === choice));
  refreshThemeToggle();
}
// The round sun / moon button: one tap switches between light and dark.
function themeToggle() {
  const dark = isDark();
  return h("button", {
    class: "theme-toggle", id: "themeToggle", type: "button",
    "aria-label": dark ? "Включить светлую тему" : "Включить тёмную тему", title: dark ? "Светлая тема" : "Тёмная тема",
    onclick: () => setTheme(isDark() ? "light" : "dark"),
  }, icon(dark ? "sun" : "moon", "u"));
}
function refreshThemeToggle() {
  document.getElementById("themeToggle")?.replaceWith(themeToggle());
}

// ---------------------------------------------------------------- saved on this device
function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
applyBackdrop();
setInterval(() => { if (backdropChoice === "auto") applyBackdrop(); }, 10 * 60 * 1000); // follow the time of day
const progress = load("learnProgress", {}); // English phrase → { box, due }
const tests = load("learnTests", {}); // lesson id → { best, last, total, at }: written test results
const skills = load("learnSkills", {}); // lesson id → { listen, read, speak: { best, last, total, at } }
let mode = load("learnMode", "understand"); // "understand": English → Russian; "speak": Russian → English

// ---------------------------------------------------------------- building the page
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
function icon(name, set = "i") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${set}-${name}`); // "i": the page's own icons, "u": lesson icons (Lucide)
  svg.append(use);
  return svg;
}
// Replaces the screen's content. Parts left out with null or false are skipped, not shown as text.
const setView = (...parts) => view.replaceChildren(...parts.flat().filter((part) => part != null && part !== false));
const backLink = (href, text) => h("a", { class: "back", href }, icon("back"), text);
const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

// ---------------------------------------------------------------- listening
// In the app, lines are read by Deepgram's American voices (GET api/tts, an MP3 the CDN keeps).
// An audio file plays even when an iPhone is on silent, unlike the phone's own voice, which is
// only the fallback. A published copy has no server: it plays the same recordings, published
// with it as one bundle per lesson (LEARN_RECORDINGS is the folder, e.g. "audio/").
const RECORDINGS = globalThis.LEARN_RECORDINGS ?? null;
const tts = "speechSynthesis" in window ? window.speechSynthesis : null;
const player = new Audio();
player.preload = "auto";
let serverTts = false; // set once the app's server says it can read aloud
let voiceChoice = load("learnVoice", "female"); // "female" (Thalia) or "male" (Orion)
// Playback speed for every play button, remembered on this device. Pitch stays natural.
const SPEEDS = [0.5, 1, 1.5, 2];
let speed = SPEEDS.includes(load("learnSpeed", 1)) ? load("learnSpeed", 1) : 1;
const speedLabel = (r) => `${String(r).replace(".", ",")}×`; // "0,5×": Russian decimal comma
const canPlay = () => Boolean(RECORDINGS || serverTts || tts);

const bundles = new Map(); // lesson id → Promise<{ text: data URL }>
const downloads = new Map(); // "voice|text" → { promise, url }

/** Where a line's audio comes from, or null when only the phone's voice can read it. */
function download(text) {
  if (RECORDINGS) {
    const lesson = PHRASE_LESSON.get(text);
    if (!lesson) return null;
    const key = `recorded|${text}`;
    if (!downloads.has(key)) {
      if (!bundles.has(lesson.id)) {
        const bundle = fetch(`${RECORDINGS}${lesson.id}.json`).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))));
        bundle.catch(() => bundles.delete(lesson.id));
        bundles.set(lesson.id, bundle);
      }
      const entry = { url: null };
      entry.promise = bundles.get(lesson.id).then((all) => all[text] ?? Promise.reject(new Error("not recorded")))
        .then((url) => (entry.url = url));
      entry.promise.catch(() => downloads.delete(key));
      downloads.set(key, entry);
    }
    return downloads.get(key);
  }
  if (!serverTts) return null;
  const key = `${voiceChoice}|${text}`;
  if (!downloads.has(key)) {
    const code = accessCode();
    const query = new URLSearchParams({ text, voice: voiceChoice, ...(code ? { code } : {}) });
    const entry = { url: null };
    entry.promise = fetch(`api/tts?${query}`)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((blob) => (entry.url = URL.createObjectURL(blob)));
    entry.promise.catch(() => downloads.delete(key));
    downloads.set(key, entry);
  }
  return downloads.get(key);
}
/** Start downloading a line's audio before it is played, so the tap plays it at once. */
const prefetch = (text) => { if (text) download(text)?.promise.catch(() => {}); };

// Phones only let sound start from a tap. When the audio is still downloading, a moment of
// silence is played inside the tap, which lets this player start once the audio arrives.
const SILENCE = (() => {
  const samples = 400;
  const bytes = new Uint8Array(44 + samples).fill(128, 44);
  const view = new DataView(bytes.buffer);
  const text = (at, str) => [...str].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, "data"); view.setUint32(40, samples, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
})();

let playingButton = null;
function markPlaying(button) {
  playingButton?.classList.remove("is-playing");
  playingButton = button ?? null;
  playingButton?.classList.add("is-playing");
}
for (const done of ["ended", "pause", "error"]) player.addEventListener(done, () => markPlaying(null));

function playFile(src, rate) {
  player.src = src;
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
  player.preservesPitch = true;
  return player.play();
}

/** Read `text` aloud in American English, at the chosen speed unless `rate` says otherwise. */
async function speak(text, rate = speed, button = null) {
  if (!text) return;
  tts?.cancel();
  player.pause();
  markPlaying(button);
  const entry = download(text);
  try {
    if (entry?.url) return await playFile(entry.url, rate); // downloaded already: plays within the tap
    if (entry) {
      player.src = SILENCE;
      player.play().catch(() => {});
      return await playFile(await entry.promise, rate);
    }
  } catch { /* fall back to the device's voice */ }
  speakWithDevice(text, rate, button);
}

let deviceVoice = null;
function pickDeviceVoice() {
  const english = tts.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  const rank = (v) =>
    (/^en[-_]US/i.test(v.lang) ? 4 : 0) + // American first
    (/natural|neural|premium|enhanced|samantha|google us english|aria|jenny/i.test(v.name) ? 2 : 0) +
    (v.localService ? 1 : 0);
  deviceVoice = english.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}
if (tts) {
  pickDeviceVoice();
  tts.addEventListener?.("voiceschanged", pickDeviceVoice);
}
function speakWithDevice(text, rate, button) {
  if (!tts) return markPlaying(null);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  if (deviceVoice) utterance.voice = deviceVoice;
  utterance.rate = rate * 0.95;
  utterance.onend = utterance.onerror = () => { if (playingButton === button) markPlaying(null); };
  tts.speak(utterance);
}

function stopSound() {
  tts?.cancel();
  player.pause();
}

function playButton(text, label = "Слушать") {
  if (!canPlay()) return null;
  return h("button", {
    class: "play", type: "button", "aria-label": `${label}: ${text}`,
    onpointerdown: () => prefetch(text),
    onclick: (e) => speak(text, speed, e.currentTarget),
  }, icon("play"));
}

/**
 * Speed choice: 0,5× · 1× · 1,5× · 2×. Picking one changes the speed everywhere and updates
 * every speed choice on the screen; `onPick` can also play something at the new speed.
 */
function speedChips(onPick) {
  return h("div", { class: "chips speed", role: "radiogroup", "aria-label": "Скорость озвучки" },
    SPEEDS.map((r) => h("button", {
      class: "chip", type: "button", role: "radio", "aria-checked": String(r === speed), "data-speed": r,
      onclick: (e) => {
        speed = r;
        save("learnSpeed", r);
        for (const chip of document.querySelectorAll(".speed .chip")) chip.setAttribute("aria-checked", String(Number(chip.dataset.speed) === r));
        onPick?.(r, e.currentTarget);
      },
    }, speedLabel(r))));
}

// English words that can be tapped to hear one at a time.
function tappableWords(text) {
  if (!canPlay()) return [text];
  return text.split(/(\s+)/).map((part) => {
    if (!part.trim()) return part;
    const word = part.replace(/[^\p{L}\p{N}'’-]/gu, "");
    return h("button", { class: "w", type: "button", onpointerdown: () => prefetch(word), onclick: () => speak(word, speed) }, part);
  });
}

// ---------------------------------------------------------------- in the subtitles app
// On the app's own server the page can check pronunciation (speech recognition needs the app's
// server for its key) and review phrases heard in films. A published copy has neither.
let inApp = false;
let Recognizer = null;
let pronounceEnglish = null;
let writingCheck = false; // the server can check sentences she writes herself

async function detectApp() {
  try {
    const res = await fetch("api/config", { cache: "no-store" });
    const config = await res.json();
    inApp = true;
    serverTts = Boolean(config.tts);
    writingCheck = Boolean(config.writing);
    if (config.cloudSpeech) ({ CloudRecognizer: Recognizer } = await import("./cloud-asr.js"));
    if (load("heardPhrases", []).length) {
      const { pronounce, loadDictionary } = await import("./pronounce.js");
      await loadDictionary();
      pronounceEnglish = (text) => pronounce(text, "en");
    }
  } catch {
    return; // not served by the app
  }
  // Show what just became available, without restarting a practice session or losing an answer
  // being typed.
  if (testRun && testRun.index < testRun.questions.length) return showFoot();
  if (drill) { if (!attempt) renderDrill(drill.kind, drill.lesson); return showFoot(); } // speaking can now be checked
  if (!session) route();
  else {
    for (const el of document.querySelectorAll("[data-needs-app]")) el.hidden = false;
    const p = session.queue[session.index];
    prefetch(p?.en);
  }
  showFoot();
}

function showFoot() {
  foot.replaceChildren("Прогресс сохраняется только на этом устройстве.");
  if (!inApp) {
    foot.append(" Проверка произношения голосом работает ", h("a", { href: `${APP_URL}learn.html`, target: "_blank", rel: "noopener" }, "в приложении"), ".");
  }
}

async function speechToken() {
  const res = await fetch("api/speech-token", { method: "POST", headers: { "X-Access-Code": accessCode() } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Нужен код доступа: откройте субтитры и введите его.");
  if (!res.ok || !data.token) throw new Error(data.error || "Не удалось включить распознавание речи.");
  return data.token;
}

let attempt = null; // the speaking attempt in progress
async function listenOnce(onInterim) {
  stopSound();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return new Promise((resolve, reject) => {
    let last = "";
    let finished = false;
    const end = (done) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      recognizer.stop();
      for (const track of stream.getTracks()) track.stop();
      attempt = null;
      done();
    };
    const recognizer = new Recognizer({
      onInterim: (text) => { last = text; onInterim(text); },
      onFinal: (text) => end(() => resolve(text)),
      onError: (message) => end(() => reject(new Error(message))),
      onStatus: () => {},
    }, speechToken);
    const timer = setTimeout(() => end(() => resolve(last)), 10000); // a long pause ends the attempt
    attempt = { finish: () => end(() => resolve(last)), cancel: () => end(() => resolve(null)) };
    recognizer.start(stream, "en").catch((err) => end(() => reject(err)));
  });
}

// ---------------------------------------------------------------- daily goal and streak
const stats = load("learnStats", { goal: 10, days: {} }); // days: dayKey → cards practised
const todayCount = () => stats.days[dayKey()] ?? 0;

/** Counts a practised card; true when it completes today's goal. */
function countCard() {
  const key = dayKey();
  const before = stats.days[key] ?? 0;
  stats.days[key] = before + 1;
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 400) delete stats.days[keys.shift()]; // a year is plenty
  save("learnStats", stats);
  return before < stats.goal && before + 1 >= stats.goal;
}

const streakText = (days) => `${days} ${plural(days, "день", "дня", "дней")} подряд`;

function goalRing(done, goal) {
  const NS = "http://www.w3.org/2000/svg";
  const r = 25;
  const length = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "ring");
  svg.setAttribute("aria-hidden", "true");
  for (const cls of ["ring-track", "ring-value"]) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", "32"); c.setAttribute("cy", "32"); c.setAttribute("r", String(r));
    c.setAttribute("class", cls);
    if (cls === "ring-value") {
      c.setAttribute("stroke-dasharray", String(length));
      c.setAttribute("stroke-dashoffset", String(length * (1 - Math.min(1, done / goal))));
    }
    svg.append(c);
  }
  return h("div", { class: `goal-ring${done >= goal ? " met" : ""}` }, svg,
    h("span", { class: "goal-num num" }, done >= goal ? icon("check") : done, h("small", {}, done >= goal ? "" : `/${goal}`)));
}

function todayCard() {
  const done = todayCount();
  const days = streak(stats.days);
  const chip = (label, checked, onclick) =>
    h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(checked), onclick }, label);
  return h("section", { class: "card today", "aria-label": "Сегодня" },
    h("div", { class: "today-main" },
      goalRing(done, stats.goal),
      h("div", { class: "today-text" },
        h("b", {}, done >= stats.goal ? "Цель на сегодня выполнена" : "Цель на сегодня"),
        h("span", { class: "num" }, `${done} из ${stats.goal} ${plural(stats.goal, "карточки", "карточек", "карточек")}`),
        h("span", { class: `streak${done ? " lit" : ""}` }, lessonIcon("flame", "streak-icon"),
          days ? streakText(days) : "Начните серию сегодня"),
      ),
    ),
    h("div", { class: "today-options" },
      h("div", { class: "option" }, h("span", { class: "option-label", id: "goalLabel" }, "Карточек в день"),
        h("div", { class: "chips", role: "radiogroup", "aria-labelledby": "goalLabel" },
          [5, 10, 20].map((n) => chip(n, stats.goal === n, () => { stats.goal = n; save("learnStats", stats); renderCourse(currentTrack); })))),
      serverTts
        ? h("div", { class: "option" }, h("span", { class: "option-label", id: "voiceLabel" }, "Голос"),
            h("div", { class: "chips", role: "radiogroup", "aria-labelledby": "voiceLabel" },
              [["female", "Женский"], ["male", "Мужской"]].map(([v, label]) => chip(label, voiceChoice === v, (e) => {
                voiceChoice = v;
                save("learnVoice", v);
                renderCourse(currentTrack);
                speak(v === "female" ? "Hi! I'll read the phrases for you." : "Hello! I'll read the phrases for you.");
              }))))
        : null,
      canPlay()
        ? h("div", { class: "option" }, h("span", { class: "option-label" }, "Скорость"),
            speedChips(() => speak("This is how fast I'll read the phrases.")))
        : null,
      h("div", { class: "option" }, h("span", { class: "option-label", id: "themeLabel" }, "Тема"),
        h("div", { class: "chips theme-choice", role: "radiogroup", "aria-labelledby": "themeLabel" },
          THEMES.map(([value, label, glyph]) => h("button", {
            class: "chip", type: "button", role: "radio", "aria-checked": String(themeChoice() === value), "data-theme": value,
            onclick: () => setTheme(value),
          }, icon(glyph, "u"), label)))),
      backdropPicker(),
    ),
  );
}

// Wallpaper choice: small pictures, like the iPhone's wallpaper gallery.
function backdropPicker() {
  const thumb = (id) => `url("${BACKDROP_DIR}${id}-thumb.webp")`;
  const lakes = ["lake-dawn", "lake-day", "lake-sunset", "lake-dusk"];
  const look = (b) => b.id === "auto"
    ? `background: ${lakes.map((id, i) => `${thumb(id)} ${i % 2 ? "100%" : "0"} ${i < 2 ? "0" : "100%"} / 50% 50% no-repeat`).join(", ")}`
    : b.id === "none" ? null : `background-image: ${thumb(b.id)}`;
  return h("div", { class: "option backdrop-option" },
    h("span", { class: "option-label", id: "bgLabel" }, "Фон"),
    h("div", { class: "swatches", role: "radiogroup", "aria-labelledby": "bgLabel" },
      BACKDROPS.map((b) => h("button", {
        class: "swatch", type: "button", role: "radio", "aria-checked": String(backdropChoice === b.id), "data-backdrop": b.id,
        onclick: () => {
          backdropChoice = b.id;
          save("learnBackdrop", b.id);
          applyBackdrop();
          for (const s of document.querySelectorAll(".swatch")) s.setAttribute("aria-checked", String(s.dataset.backdrop === b.id));
        },
      }, h("span", { class: `swatch-img${b.id === "none" ? " plain" : ""}`, style: look(b) }), h("span", { class: "swatch-label" }, b.label)))),
  );
}

// A short burst of confetti for a met goal or a finished unit (skipped when motion is reduced).
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = h("canvas", { class: "confetti", "aria-hidden": "true" });
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colors = ["--accent", "--ok", "--say", "--miss", "--flame"].map((v) => css.getPropertyValue(v).trim());
  const bits = Array.from({ length: 110 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3, size: 5 + Math.random() * 5,
    spin: Math.random() * 6, color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const startedAt = performance.now();
  (function frame(now) {
    const t = now - startedAt;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.25; b.x += b.vx; b.y += b.vy; b.vx *= 0.99;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 1800);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.spin * t / 300);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
      ctx.restore();
    }
    if (t < 1800) requestAnimationFrame(frame);
    else canvas.remove();
  })(startedAt);
}

// ---------------------------------------------------------------- course data
const ALL_PHRASES = LESSONS.flatMap((lesson) => lesson.phrases);
// Each English line (phrases and grammar examples) → its lesson.
const PHRASE_LESSON = new Map(LESSONS.flatMap((lesson) => [...(lesson.examples ?? []), ...lesson.phrases].map((p) => [p.en, lesson])));
const levelOf = (lesson) => LEVELS.find((l) => l.id === lesson.level);
const trackOf = (lesson) => levelOf(lesson).track;
const trackLessons = (track) => LESSONS.filter((lesson) => trackOf(lesson) === track);
// Units are numbered within their track: Каждый день 1–30, Грамматика 1–16, Работа 1–16.
const UNIT_NO = new Map(TRACKS.flatMap((t) => trackLessons(t.id).map((lesson, i) => [lesson.id, i + 1])));
const knownOnce = (phrase) => (progress[phrase.en]?.box ?? 0) >= 1;
// A lesson is a checklist of five tasks, one per skill: learn the phrases with cards (each one
// "Знаю" at least once), then listening, reading, speaking and writing, each passed with 6 of 8 or
// better. All five ticked: the lesson is done and turns green.
const TEST_SIZE = 8;
const testTotal = (lesson) => Math.min(TEST_SIZE, lesson.phrases.length);
const testNeed = (total) => Math.ceil(total * 0.75);
const TASKS = [
  { key: "cards", title: "Карточки", icon: "layers", what: "Выучить фразы урока" },
  { key: "listen", title: "Аудирование", icon: "headphones", what: "Послушать и выбрать, что прозвучало" },
  { key: "read", title: "Чтение", icon: "book-open-text", what: "Прочитать и выбрать перевод" },
  { key: "speak", title: "Говорение", icon: "mic", what: "Сказать фразы по-английски вслух" },
  { key: "write", title: "Письмо", icon: "pencil-line", what: "Написать фразы по-английски" },
];
const taskHref = (lesson, key) => (key === "cards" ? `#practice-${lesson.id}` : key === "write" ? `#test-${lesson.id}` : `#${key}-${lesson.id}`);
const taskResult = (lesson, key) => (key === "write" ? tests[lesson.id] : skills[lesson.id]?.[key]);
const phrasesDone = (lesson) => lesson.phrases.every(knownOnce);
function taskDone(lesson, key) {
  if (key === "cards") return phrasesDone(lesson);
  const r = taskResult(lesson, key);
  return Boolean(r) && r.best >= testNeed(r.total);
}
/** How far through one task, 0 to 1. */
function taskShare(lesson, key) {
  if (taskDone(lesson, key)) return 1;
  if (key === "cards") return lesson.phrases.filter(knownOnce).length / lesson.phrases.length;
  const r = taskResult(lesson, key);
  return r ? Math.min(1, r.best / testNeed(r.total)) : 0;
}
const testPassed = (lesson) => taskDone(lesson, "write");
const unitDone = (lesson) => TASKS.every((t) => taskDone(lesson, t.key));
/** How far through its checklist a lesson is, 0 to 1. */
const unitProgress = (lesson) => TASKS.reduce((sum, t) => sum + taskShare(lesson, t.key), 0) / TASKS.length;
const nextTask = (lesson) => TASKS.find((t) => !taskDone(lesson, t.key));
const doneCount = (lesson) => TASKS.filter((t) => taskDone(lesson, t.key)).length;
const nextLesson = (track) => trackLessons(track).find((lesson) => !unitDone(lesson));
let currentTrack = TRACKS.some((t) => t.id === load("learnTrack", "")) ? load("learnTrack", "") : TRACKS[0].id;

// A checklist mark: an empty circle, a ring filling up in blue, then a green circle with a tick.
function tick(fraction, label) {
  if (fraction >= 1) return h("span", { class: "tick done", role: "img", "aria-label": label ?? "Готово" }, icon("check"));
  const NS = "http://www.w3.org/2000/svg";
  const r = 11.5;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 28 28");
  svg.setAttribute("class", "arc");
  svg.setAttribute("aria-hidden", "true");
  for (const cls of fraction > 0 ? ["ring-track", "ring-value"] : ["ring-track"]) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", "14"); c.setAttribute("cy", "14"); c.setAttribute("r", String(r));
    c.setAttribute("class", cls);
    if (cls === "ring-value") {
      const length = 2 * Math.PI * r;
      c.setAttribute("stroke-dasharray", String(length));
      c.setAttribute("stroke-dashoffset", String(length * (1 - fraction)));
    }
    svg.append(c);
  }
  return h("span", { class: "tick", role: "img", "aria-label": label ?? `Выполнено на ${Math.round(fraction * 100)}%` }, svg);
}

// The five tasks as small icons in a row, each green once done.
function taskChips(lesson) {
  const count = doneCount(lesson);
  return h("span", { class: "tasks", role: "img", "aria-label": `Заданий выполнено: ${count} из ${TASKS.length}` },
    TASKS.map((t) => h("span", { class: `task${taskDone(lesson, t.key) ? " done" : ""}`, title: t.title }, icon(t.icon, "u"))),
    h("span", { class: "task-sum num" }, `${count}/${TASKS.length}`));
}

// The lesson's checklist, on its page and when an exercise ends.
function lessonTasks(lesson) {
  const known = lesson.phrases.filter(knownOnce).length;
  const total = lesson.phrases.length;
  const count = doneCount(lesson);
  const note = (t) => {
    if (t.key === "cards") {
      return phrasesDone(lesson) ? `Все ${total} ${plural(total, "фраза", "фразы", "фраз")} выучены` : `Карточки: «Знаю» на каждой фразе · ${known} из ${total}`;
    }
    const r = taskResult(lesson, t.key);
    const of = r?.total ?? testTotal(lesson);
    if (taskDone(lesson, t.key)) return `Сдано: ${r.best} из ${r.total}`;
    return r ? `Нужно ${testNeed(of)} из ${of} · лучший результат ${r.best}` : `${t.what} · нужно ${testNeed(of)} из ${of}`;
  };
  return h("section", { class: `card tasks-card${count === TASKS.length ? " done" : ""}`, "aria-label": "Задания урока" },
    h("div", { class: "card-head" },
      h("h2", {}, "Задания урока"),
      h("span", { class: "task-count num" }, count === TASKS.length ? [lessonIcon("trophy", "task-trophy"), "Урок пройден"] : `${count} из ${TASKS.length}`)),
    h("ol", { class: "task-list" }, TASKS.map((t) => {
      const done = taskDone(lesson, t.key);
      return h("li", {},
        h("a", { class: `task-row${done ? " done" : ""}`, href: taskHref(lesson, t.key) },
          tick(taskShare(lesson, t.key), done ? "Выполнено" : "Не выполнено"),
          h("span", { class: "unit-text" }, h("b", {}, icon(t.icon, "u"), t.title), h("small", {}, note(t))),
          icon("next")));
    })),
  );
}

// The next thing to do after an exercise: the lesson's next task, or the next lesson once it's done.
function nextStepButton(lesson, primary = true) {
  const cls = `btn${primary ? " primary" : ""}`;
  const t = nextTask(lesson);
  if (t) return h("a", { class: cls, href: taskHref(lesson, t.key) }, icon(t.icon, "u"), `Дальше: ${t.title}`);
  const siblings = trackLessons(trackOf(lesson));
  const next = siblings[siblings.indexOf(lesson) + 1];
  return next ? h("a", { class: cls, href: `#unit-${next.id}` }, `Урок ${UNIT_NO.get(next.id)}: ${next.title}`, icon("next")) : null;
}

// A lesson's picture: a Lucide icon from the sprite in learn.html.
function lessonIcon(name, cls = "tile") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#u-${name}`);
  svg.append(use);
  return h("span", { class: cls, "aria-hidden": "true" }, svg);
}

function filmPhrases() {
  return load("heardPhrases", [])
    .slice()
    .reverse() // newest first
    .map(({ en, ru }) => ({ en, ru, say: pronounceEnglish?.(en) ?? "" }));
}

function deckFor(id) {
  if (id === "review") {
    const now = Date.now();
    const due = [...ALL_PHRASES, ...filmPhrases()].filter((p) => isDue(progress[p.en], now));
    due.sort((a, b) => progress[a.en].due - progress[b.en].due);
    return { id, title: "Повторение", back: `#${currentTrack}`, phrases: due.slice(0, 30) };
  }
  if (id === "films") return { id, title: "Фразы из фильмов", back: "#daily", phrases: filmPhrases().slice(0, 40) };
  if (id === "mistakes") return mistakesDeck;
  const lesson = LESSONS.find((l) => l.id === id);
  return lesson && { id, title: lesson.title, back: `#unit-${id}`, phrases: lesson.phrases, lesson };
}

// ---------------------------------------------------------------- views
function renderCourse(track = currentTrack) {
  currentTrack = track;
  save("learnTrack", track);
  document.title = "Курс английского";
  const info = TRACKS.find((t) => t.id === track);
  const lessons = trackLessons(track);
  const phrases = lessons.flatMap((lesson) => lesson.phrases);
  const practised = phrases.filter(knownOnce).length;
  const learned = phrases.filter((p) => isLearned(progress[p.en])).length;
  const now = Date.now();
  const due = [...ALL_PHRASES, ...filmPhrases()].filter((p) => isDue(progress[p.en], now)).length;
  const next = nextLesson(track);
  const films = load("heardPhrases", []).length;
  const started = (lesson) => lesson.phrases.some(knownOnce) || Boolean(tests[lesson.id] || skills[lesson.id]);

  setView(
    h("div", { class: "nav" },
      inApp ? backLink("./", "Субтитры") : h("a", { class: "back", href: APP_URL, target: "_blank", rel: "noopener" }, icon("back"), "Субтитры"),
      themeToggle(),
    ),
    h("header", {},
      h("h1", {}, "Курс английского"),
      h("p", { class: "lede" }, `${LESSONS.length} ${plural(LESSONS.length, "урок", "урока", "уроков")} в трёх разделах и семи уровнях: от A (первые слова) до G (как носитель). В каждом уроке — пять заданий: карточки, аудирование, чтение, говорение и письмо.`),
    ),
    todayCard(),
    h("nav", { class: "tracks", "aria-label": "Разделы курса" },
      TRACKS.map((t) => h("a", { class: "track", href: `#${t.id}`, "aria-current": t.id === track ? "page" : null },
        lessonIcon(t.icon, "track-icon"), h("span", {}, t.title)))),
    h("section", { class: "card summary", "aria-label": "Прогресс" },
      h("p", { class: "summary-about" }, info.about),
      h("div", { class: "summary-stat" },
        h("b", { class: "num" }, practised),
        h("span", {}, `из ${phrases.length} ${plural(phrases.length, "фразы", "фраз", "фраз")} пройдено`),
      ),
      h("div", { class: `meter${!next ? " done" : ""}` }, h("i", { style: `width: ${(practised / phrases.length) * 100}%` })),
      practised ? h("p", { class: "summary-note" }, `Закреплено повторением: ${learned}. Пройденные фразы возвращаются через день, 3 дня, неделю и дольше.`) : null,
      h("div", { class: "btn-row" },
        next
          ? h("a", { class: "btn primary", href: `#unit-${next.id}` }, `${started(next) || practised ? "Продолжить" : "Начать"}: урок ${UNIT_NO.get(next.id)}`, icon("next"))
          : h("span", { class: "btn" }, "Все уроки раздела пройдены"),
        due ? h("a", { class: "btn", href: "#practice-review" }, icon("repeat"), `Повторить · ${due}`) : null,
        track === "grammar" ? h("a", { class: "btn", href: "#grammar-plan" }, icon("calendar", "u"), "Программа и план") : null,
      ),
    ),
    ...LEVELS.filter((level) => level.track === track).map((level) => {
      const lessons = LESSONS.filter((lesson) => lesson.level === level.id);
      const doneCount = lessons.filter(unitDone).length;
      const levelDone = doneCount === lessons.length;
      const share = lessons.reduce((sum, lesson) => sum + unitProgress(lesson), 0) / lessons.length;
      return h("section", { class: `level${levelDone ? " done" : ""}`, "aria-label": level.title },
        h("div", { class: "level-head" },
          h("span", { class: "badge" }, level.badge ?? level.id), h("h3", {}, level.title),
          h("span", { class: "level-count num", "aria-label": `Пройдено уроков: ${doneCount} из ${lessons.length}` }, levelDone ? icon("check") : null, `${doneCount} из ${lessons.length}`)),
        h("p", { class: "level-about" }, level.about),
        h("div", { class: `meter thin${levelDone ? " done" : ""}` }, h("i", { style: `width: ${share * 100}%` })),
        h("ol", { class: "units" }, lessons.map((lesson) => unitRow(lesson, next))),
      );
    }),
    track === "daily" && films
      ? h("section", { class: "level", "aria-label": "Из фильмов" },
          h("div", { class: "level-head" }, h("h3", {}, "Из ваших фильмов")),
          h("p", { class: "level-about" }, "Фразы, которые прозвучали в режиме живых субтитров."),
          h("ol", { class: "units" }, h("li", {},
            h("a", { class: "unit", href: "#practice-films" },
              h("span", { class: "tile", "aria-hidden": "true" }, icon("film")),
              h("span", { class: "unit-text" }, h("b", {}, "Фразы из фильмов"), h("small", { class: "num" }, `${films} ${plural(films, "фраза", "фразы", "фраз")}`)),
              icon("next"),
            ),
          )),
        )
      : null,
  );
}

// A lesson in the course list: its icon, title, the two tasks once started, and a checklist mark
// that fills up and turns into a green tick when the lesson is done.
function unitRow(lesson, next) {
  const done = unitDone(lesson);
  const started = lesson.phrases.some(knownOnce) || Boolean(tests[lesson.id] || skills[lesson.id]);
  return h("li", {},
    h("a", { class: `unit${done ? " done" : ""}${lesson === next ? " next" : ""}`, href: `#unit-${lesson.id}` },
      lessonIcon(lesson.icon),
      h("span", { class: "unit-text" },
        h("b", {}, lesson.title),
        h("small", {}, `${UNIT_NO.get(lesson.id)} · ${lesson.en}`, done ? h("span", { class: "done-word" }, " · пройдено") : null),
        started && !done ? taskChips(lesson) : null,
      ),
      tick(unitProgress(lesson), done ? "Урок пройден" : `Урок пройден на ${Math.round(unitProgress(lesson) * 100)}%`),
    ),
  );
}

// The grammar programme: how a lesson works, every unit with what it teaches, and a 16-week plan
// that pairs each grammar unit with two everyday lessons, marking the week she is on.
function renderGrammarPlan() {
  document.title = "Программа по грамматике · Курс английского";
  const grammar = trackLessons("grammar");
  const daily = trackLessons("daily");
  const next = nextLesson("grammar");
  const nowWeek = next ? grammar.indexOf(next) : -1;
  const link = (lesson) => h("a", { href: `#unit-${lesson.id}`, class: unitDone(lesson) ? "done" : null }, lesson.title);

  const planRow = (lesson) => {
    const done = unitDone(lesson);
    const mistake = lesson.mistakes?.[0];
    return h("li", {},
      h("a", { class: `unit plan-unit${done ? " done" : ""}${lesson === next ? " next" : ""}`, href: `#unit-${lesson.id}` },
        lessonIcon(lesson.icon),
        h("span", { class: "unit-text" },
          h("small", {}, `Урок ${UNIT_NO.get(lesson.id)} · ${lesson.en}`, done ? h("span", { class: "done-word" }, " · пройдено") : null),
          h("b", {}, lesson.title),
          h("span", { class: "plan-goal" }, lesson.goal),
          mistake ? h("span", { class: "plan-mistake", lang: "en" },
            h("s", {}, h("span", { class: "visually-hidden" }, "Неправильно: "), mistake.wrong), " → ",
            h("span", { class: "right" }, h("span", { class: "visually-hidden" }, "Правильно: "), mistake.right)) : null,
          lesson.phrases.some(knownOnce) || tests[lesson.id] || skills[lesson.id] ? taskChips(lesson) : null,
        ),
        tick(unitProgress(lesson), done ? "Урок пройден" : `Урок пройден на ${Math.round(unitProgress(lesson) * 100)}%`),
      ),
    );
  };

  setView(
    h("div", { class: "nav" }, backLink("#grammar", "Грамматика")),
    h("header", {},
      h("p", { class: "eyebrow" }, "Курс английского · Грамматика"),
      h("h1", {}, "Программа по грамматике"),
      h("p", { class: "lede" }, `${grammar.length} ${plural(grammar.length, "урок", "урока", "уроков")} на уровнях от B до G: от местоимений и to be до инверсии и смешанных условных предложений. По одному уроку в неделю — около ${Math.round(grammar.length / 4.35)} месяцев.`),
    ),
    h("section", { class: "card" },
      h("h2", {}, "Как устроен урок"),
      h("ol", { class: "steps" }, [
        ["Правило", "коротко и по-русски"],
        ["Формы", "таблица: утверждение, отрицание, вопрос"],
        ["Частые ошибки", "как обычно ошибаются русскоговорящие и как правильно"],
        ["Примеры", "8 фраз с переводом, произношением русскими буквами и американской озвучкой"],
        ["Пять заданий", "карточки, аудирование, чтение, говорение и письмо — урок пройден, когда все пять отмечены"],
      ].map(([what, how]) => h("li", {}, h("b", {}, what), h("span", {}, how)))),
    ),
    ...LEVELS.filter((level) => level.track === "grammar").map((level) =>
      h("section", { class: "level", "aria-label": level.title },
        h("div", { class: "level-head" }, h("span", { class: "badge" }, level.badge ?? level.id), h("h3", {}, level.title)),
        h("p", { class: "level-about" }, level.about),
        h("ol", { class: "units" }, LESSONS.filter((lesson) => lesson.level === level.id).map(planRow)),
      )),
    h("section", { class: "card", id: "weeks" },
      h("h2", {}, `План на ${grammar.length} недель`),
      h("p", { class: "plan-note" }, "Каждую неделю — один урок грамматики и два урока из раздела «Каждый день». В день — около 10 карточек, это 5–10 минут."),
      h("div", { class: "table-wrap" }, h("table", { class: "weeks" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Неделя"), h("th", { scope: "col" }, "Грамматика"), h("th", { scope: "col" }, "Каждый день"))),
        h("tbody", {}, grammar.map((lesson, i) => {
          const pair = daily.slice(i * 2, i * 2 + 2);
          const weekDone = [lesson, ...pair].every(unitDone);
          return h("tr", { class: i === nowWeek ? "now" : weekDone ? "done" : null },
            h("td", { class: "num" }, i + 1, i === nowWeek ? h("span", { class: "pill" }, "сейчас") : null),
            h("td", {}, link(lesson)),
            h("td", {}, pair.length ? pair.flatMap((d, k) => [k ? h("br") : null, link(d)]) : "Повторение пройденного"),
          );
        })),
      )),
    ),
    h("section", { class: "card" },
      h("h2", {}, "Как заниматься"),
      h("ul", { class: "tips" }, [
        "Понемногу, но каждый день: 10 карточек лучше, чем час раз в неделю.",
        "Сначала послушайте фразу, потом медленно, потом повторите вслух.",
        "В режиме «Говорить» нажмите «Сказать»: приложение покажет, какие слова не расслышало.",
        "Не пропускайте «Повторить»: фразы возвращаются через 1, 3, 7, 14 и 30 дней.",
        "После 10-й недели добавьте раздел «Работа» — по уроку в неделю.",
      ].map((tip) => h("li", {}, tip))),
    ),
    next
      ? h("a", { class: "btn primary wide", href: `#unit-${next.id}` }, `${next.phrases.some(knownOnce) ? "Продолжить" : "Начать"}: урок ${UNIT_NO.get(next.id)} · ${next.title}`, icon("next"))
      : h("span", { class: "btn wide" }, "Все уроки грамматики пройдены"),
  );
}

function renderUnit(lesson) {
  const level = levelOf(lesson);
  const track = TRACKS.find((t) => t.id === level.track);
  const isGrammar = Boolean(lesson.table);
  document.title = `${lesson.title} · Курс английского`;
  const line = (en, say, ru) => h("span", { class: "line-text" },
    h("span", { class: "en", lang: "en" }, en),
    say ? h("span", { class: "say", lang: "ru" }, say) : null,
    h("span", { class: "ru" }, ru));

  setView(
    h("div", { class: "nav" }, backLink(`#${track.id}`, track.title)),
    h("header", { class: "unit-head" },
      lessonIcon(lesson.icon, "tile big"),
      h("div", {},
        h("p", { class: "eyebrow" }, [track.title, `урок ${UNIT_NO.get(lesson.id)}`, level.badge ?? level.id].filter((x, i, all) => all.indexOf(x) === i).join(" · ")),
        h("h1", {}, lesson.title),
        h("p", { class: "lede" }, `Цель: ${lesson.goal[0].toLowerCase()}${lesson.goal.slice(1)}`),
      ),
    ),
    lessonTasks(lesson),
    h("section", { class: "card grammar" },
      h("h2", {}, isGrammar ? "Правило" : "Грамматика"),
      h("p", {}, lesson.grammar),
      lesson.examples?.length
        ? h("ul", { class: "examples" }, lesson.examples.map((ex) => h("li", {}, playButton(ex.en), line(ex.en, "", ex.ru))))
        : null,
    ),
    isGrammar
      ? h("section", { class: "card" },
          h("h2", {}, "Формы"),
          h("div", { class: "table-wrap" }, h("table", { class: "forms" },
            h("tbody", {}, lesson.table.map((row) =>
              h("tr", {}, h("th", { scope: "row" }, row.form), h("td", {}, h("span", { class: "en", lang: "en" }, row.en), h("span", { class: "ru" }, row.ru))))),
          )),
        )
      : null,
    lesson.mistakes
      ? h("section", { class: "card" },
          h("h2", {}, "Частые ошибки"),
          h("ul", { class: "mistakes" }, lesson.mistakes.map((m) =>
            h("li", {},
              h("span", { class: "wrong", lang: "en" }, h("span", { class: "visually-hidden" }, "Неправильно: "), m.wrong),
              h("span", { class: "right", lang: "en" }, h("span", { class: "visually-hidden" }, "Правильно: "), m.right),
              h("span", { class: "why" }, m.why),
            ))),
        )
      : null,
    h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("h2", {}, `${isGrammar ? "Примеры" : "Фразы урока"} · ${lesson.phrases.filter(knownOnce).length} из ${lesson.phrases.length}`),
        canPlay() ? speedChips() : null),
      h("ol", { class: "phrase-list" }, lesson.phrases.map((p) => h("li", {}, playButton(p.en), line(p.en, p.say, p.ru),
        h("span", { class: `phrase-tick${knownOnce(p) ? " on" : ""}`, role: "img", "aria-label": knownOnce(p) ? "Выучена" : "Ещё не выучена" }, icon("check"))))),
    ),
    h("div", { class: "btn-stack" }, nextStepButton(lesson)),
  );
}

// ---------------------------------------------------------------- practice
let session = null; // { deck, queue, index, knew, again, revealed, feedback }

function startSession(deck) {
  session = { deck, queue: deck.phrases.slice(), index: 0, knew: 0, again: 0, revealed: false, feedback: null };
}

function renderPractice(deck) {
  if (session?.deck.id !== deck.id) startSession(deck);
  if (session.index >= session.queue.length) return renderDone();
  const s = session;
  const p = s.queue[s.index];
  const understand = mode === "understand";
  document.title = `${deck.title} · Курс английского`;

  prefetch(p.en);
  prefetch(s.queue[s.index + 1]?.en);
  const english = [h("div", { class: "en-big", lang: "en" }, tappableWords(p.en)), p.say ? h("div", { class: "say", lang: "ru" }, p.say) : null];
  const owner = PHRASE_LESSON.get(p.en);
  const isNewCard = s.shownIndex !== s.index;
  s.shownIndex = s.index;
  const celebrate = s.celebrate;
  s.celebrate = null;
  const front = understand
    ? english
    : [h("div", { class: "ru-big" }, p.ru), h("p", { class: "hint" }, "Как сказать это по-английски? Скажите вслух, затем проверьте.")];
  const back = understand ? [h("div", { class: "ru" }, p.ru)] : english;

  const setMode = (m) => {
    mode = m;
    save("learnMode", m);
    s.revealed = false;
    s.feedback = null;
    renderPractice(deck);
  };

  setView(
    h("div", { class: "nav" },
      backLink(deck.back, deck.backText ?? (deck.lesson ? "Урок" : "Курс")),
      h("span", { class: "count num" }, `${Math.min(s.index + 1, s.queue.length)} из ${s.queue.length}`),
    ),
    h("div", { class: "meter" }, h("i", { style: `width: ${(s.index / s.queue.length) * 100}%` })),
    h("div", { class: "chips modes", role: "radiogroup", "aria-label": "Режим" },
      h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(understand), onclick: () => setMode("understand") }, "Понимать"),
      h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(!understand), onclick: () => setMode("speak") }, "Говорить"),
    ),
    celebrate
      ? h("div", { class: "celebrate", role: "status" }, lessonIcon("trophy", "celebrate-icon"),
          h("span", {}, h("b", {}, "Цель на сегодня выполнена!"), ` ${streakText(streak(stats.days))}. Можно продолжать.`))
      : null,
    h("section", { class: `card flash${isNewCard ? " enter" : ""}`, "aria-label": deck.title },
      h("div", { class: "flash-head" },
        owner ? lessonIcon(owner.icon, "tile small") : h("span", { class: "tile small", "aria-hidden": "true" }, icon("film")),
        h("span", {}, owner ? owner.title : deck.title),
      ),
      h("div", { class: "front" }, front),
      s.revealed
        ? h("div", { class: "back" }, back)
        : h("button", { class: "btn reveal", type: "button", onclick: () => { s.revealed = true; renderPractice(deck); } }, understand ? "Показать перевод" : "Показать ответ"),
      h("div", { class: "tools" },
        canPlay() ? h("button", { class: "btn listen", type: "button", onclick: (e) => speak(p.en, speed, e.currentTarget) }, icon("play"), "Слушать") : null,
        h("button", { class: "btn", type: "button", id: "sayBtn", "data-needs-app": "", hidden: !Recognizer, onclick: () => checkSpeech(p) }, icon("mic"), "Сказать"),
        canPlay() ? speedChips((r, chip) => speak(p.en, r, chip)) : null,
      ),
      feedbackBlock(s.feedback),
    ),
    h("div", { class: "grade" },
      h("button", { class: "btn", type: "button", onclick: () => gradeCard(false) }, icon("repeat"), "Ещё раз"),
      h("button", { class: "btn primary", type: "button", onclick: () => gradeCard(true) }, icon("check"), "Знаю"),
    ),
    h("p", { class: "tip" }, canPlay() ? "Нажмите на английское слово, чтобы услышать его отдельно." : "Озвучка недоступна в этом браузере."),
  );
}

function feedbackBlock(f) {
  if (!f) return null;
  if (f.state === "listening") {
    return h("div", { class: "feedback", role: "status" },
      h("span", { class: "verdict" }, "Говорите…"),
      h("span", { class: "heard", id: "interim" }, f.heard || "Скажите фразу по-английски."),
    );
  }
  if (f.state === "error") return h("div", { class: "feedback bad", role: "status" }, h("span", {}, f.message));
  const { words, score } = f.result;
  return h("div", { class: `feedback ${score >= 0.9 ? "good" : score < 0.6 ? "bad" : ""}`, role: "status" },
    h("span", { class: "verdict" }, `${verdict(score)} `, h("span", { class: "num" }, `${Math.round(score * 100)}%`)),
    h("span", { class: "marked", lang: "en" }, words.flatMap((w, i) => [i ? " " : "", h("span", { class: w.ok ? "ok" : "miss" }, w.word)])),
    h("span", { class: "heard" }, f.heard ? `Распознано: «${f.heard}»` : "Ничего не расслышали. Попробуйте говорить ближе к микрофону."),
  );
}

async function checkSpeech(phrase) {
  const s = session;
  if (attempt) return attempt.finish(); // second tap: done speaking
  s.feedback = { state: "listening", heard: "" };
  renderPractice(s.deck);
  const btn = document.getElementById("sayBtn");
  btn.replaceChildren(icon("stop"), "Готово");
  btn.classList.add("rec");
  try {
    const heard = await listenOnce((text) => {
      const el = document.getElementById("interim");
      if (el) el.textContent = text;
    });
    if (session !== s || heard === null) return;
    s.feedback = { state: "result", heard, result: compareSpeech(phrase.en, heard) };
    s.revealed = true;
  } catch (err) {
    if (session !== s) return;
    const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
    s.feedback = { state: "error", message: denied ? "Разрешите доступ к микрофону в настройках браузера и попробуйте снова." : err.message };
  }
  renderPractice(s.deck);
}

function gradeCard(knew) {
  const s = session;
  attempt?.cancel();
  const p = s.queue[s.index];
  progress[p.en] = grade(progress[p.en], knew);
  save("learnProgress", progress);
  if (knew) s.knew++;
  else {
    s.again++;
    s.queue.splice(Math.min(s.index + 3, s.queue.length), 0, p); // comes back in a few cards
  }
  if (countCard()) s.celebrate = true;
  s.index++;
  s.revealed = false;
  s.feedback = null;
  stopSound();
  renderPractice(s.deck);
  if (s.celebrate && s.index < s.queue.length) confetti();
}

function renderDone() {
  const { deck, knew, again } = session;
  const lesson = deck.lesson;
  const learned = lesson && phrasesDone(lesson);
  const done = lesson && unitDone(lesson);
  if (!session.celebrated) { session.celebrated = true; confetti(); }
  const courseHash = lesson ? `#${trackOf(lesson)}` : `#${currentTrack}`;
  const again_ = () => { startSession(deckFor(deck.id) ?? deck); renderPractice(session.deck); };
  setView(
    h("div", { class: "nav" }, backLink(courseHash, "Курс")),
    h("section", { class: "card done-card" },
      done ? lessonIcon("trophy", "done-mark") : h("span", { class: "done-mark" }, icon("check")),
      h("h1", {}, done ? `Урок ${UNIT_NO.get(lesson.id)} пройден` : learned ? "Фразы выучены" : "Готово"),
      h("div", { class: "done-stats" },
        h("span", {}, h("b", { class: "num" }, knew), "знаю"),
        h("span", {}, h("b", { class: "num" }, again), "повторили"),
        h("span", {}, h("b", { class: "num" }, streak(stats.days)), plural(streak(stats.days), "день подряд", "дня подряд", "дней подряд")),
      ),
      h("p", { class: "lede" },
        done ? "Все задания урока выполнены. Фразы вернутся на повторение через день, потом через 3 дня, неделю и дольше."
          : learned ? `Карточки отмечены. Следующее задание — ${nextTask(lesson).title.toLowerCase()}.`
          : lesson ? "Пройдите карточки ещё раз, чтобы отметить все фразы урока."
          : "Фразы вернутся на повторение через день, потом через 3 дня, неделю и дольше."),
    ),
    lesson ? lessonTasks(lesson) : null,
    h("div", { class: "btn-stack" },
      lesson && learned ? nextStepButton(lesson) : null,
      h("button", { class: `btn${lesson && !learned ? " primary" : ""}`, type: "button", onclick: again_ }, icon("repeat"), "Ещё раз"),
      h("a", { class: "btn", href: courseHash }, "К курсу"),
    ),
  );
}

// ---------------------------------------------------------------- written test (#test-cafe)
// The lesson's phrases in Russian, in a new order: she types each in English and it is marked
// like a written test. Then she can write sentences of her own, which Claude checks.
let testRun = null; // { lesson, questions, index, answers: [{ typed, result, accepted, before }], own: [] }
let mistakesDeck = null; // the test's mistakes, to practise as cards

function startTest(lesson) {
  testRun = { lesson, questions: testQuestions(lesson.phrases, TEST_SIZE), index: 0, answers: [], draft: "", own: [], ownDraft: "" };
}
const isRight = (a) => a.result.correct || a.accepted;
const testScore = (run) => run.answers.filter(isRight).length;

function accessCode() {
  try { return localStorage.getItem("accessCode") || ""; } catch { return ""; }
}

// Her answer and the right one, word by word: wrong or extra words struck out in hers, the
// words she left out marked in the right one, and a word one letter off shown with its fix.
function markedAnswer(words, cls) {
  return h("span", { class: `marked ${cls}`, lang: "en" },
    words.flatMap((w, i) => [i ? " " : "", h("span", { class: w.ok ? null : w.near ? "near" : "x" }, w.word)]));
}

function checkBlock(q, a) {
  const { result } = a;
  const right = isRight(a);
  const state = right ? "good" : result.score >= 0.6 ? "almost" : "bad";
  const title = a.accepted ? "Засчитано" : result.correct ? "Верно!" : state === "almost" ? "Почти" : a.typed.trim() ? "Неверно" : "Правильный ответ";
  return h("div", { class: `check ${state}`, role: "status" },
    h("span", { class: "verdict" }, right ? icon("check") : null, title),
    a.typed.trim() && !result.correct
      ? h("div", { class: "check-row" }, h("span", { class: "label" }, "Ваш ответ"), markedAnswer(result.typed, "typed"))
      : null,
    h("div", { class: "check-row" },
      result.correct ? null : h("span", { class: "label" }, "Правильно"),
      h("div", { class: "answer-line" }, playButton(q.en), h("span", { class: "line-text" },
        result.correct ? h("span", { class: "en", lang: "en" }, q.en) : markedAnswer(result.answer, "right"),
        q.say ? h("span", { class: "say", lang: "ru" }, q.say) : null)),
    ),
    result.fixes.length && !result.correct
      ? h("p", { class: "fixes" }, "Проверьте написание: ", result.fixes.flatMap((f, i) => [i ? ", " : "", h("span", { lang: "en" }, h("s", {}, f.typed), " → ", h("b", {}, f.right))]))
      : null,
    !right && a.typed.trim()
      ? h("button", { class: "btn small", type: "button", onclick: () => acceptAnswer() }, "Мой ответ тоже верный")
      : null,
  );
}

function renderTest(lesson) {
  if (testRun?.lesson !== lesson) startTest(lesson);
  const t = testRun;
  if (t.index >= t.questions.length) return renderTestResults();
  const q = t.questions[t.index];
  const a = t.answers[t.index];
  const isNewCard = t.shownIndex !== t.index;
  t.shownIndex = t.index;
  const celebrate = t.celebrate;
  t.celebrate = null;
  document.title = `Тест · ${lesson.title} · Курс английского`;
  prefetch(q.en);

  const field = h("textarea", {
    class: "answer", id: "answer", lang: "en", rows: "3", "aria-label": "Ваш ответ по-английски",
    placeholder: "Напишите по-английски", autocomplete: "off", autocorrect: "off", autocapitalize: "sentences",
    spellcheck: "false", enterkeyhint: "done",
    oninput: (e) => { t.draft = e.target.value; e.target.classList.remove("cyrillic"); document.getElementById("keyboardHint")?.remove(); },
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); checkAnswer(); } },
  });
  field.value = t.draft;

  setView(
    h("div", { class: "nav" },
      backLink(`#unit-${lesson.id}`, "Урок"),
      h("span", { class: "count num" }, `${t.index + 1} из ${t.questions.length}`),
    ),
    h("div", { class: "meter" }, h("i", { style: `width: ${(t.answers.length / t.questions.length) * 100}%` })),
    celebrate
      ? h("div", { class: "celebrate", role: "status" }, lessonIcon("trophy", "celebrate-icon"),
          h("span", {}, h("b", {}, "Цель на сегодня выполнена!"), ` ${streakText(streak(stats.days))}.`))
      : null,
    h("section", { class: `card flash test${isNewCard ? " enter" : ""}`, "aria-label": `Тест: ${lesson.title}` },
      h("div", { class: "flash-head" }, lessonIcon(lesson.icon, "tile small"), h("span", {}, `Тест · ${lesson.title}`)),
      h("div", { class: "front" },
        h("p", { class: "hint" }, "Как это сказать по-английски?"),
        h("div", { class: "ru-big" }, q.ru),
      ),
      a ? checkBlock(q, a) : field,
    ),
    a
      ? h("button", { class: "btn primary wide", type: "button", id: "nextBtn", onclick: () => nextQuestion() },
          t.index + 1 < t.questions.length ? "Дальше" : "Результаты", icon("next"))
      : h("div", { class: "grade" },
          h("button", { class: "btn", type: "button", onclick: () => checkAnswer(true) }, "Не знаю"),
          h("button", { class: "btn primary", type: "button", onclick: () => checkAnswer() }, icon("check"), "Проверить")),
    h("p", { class: "tip" }, "Заглавные буквы и знаки препинания не важны; I'm и I\u00a0am — одно и то же."),
  );
  // After checking, Enter goes on to the next phrase; on a phone the keyboard closes to show the marks.
  if (a) document.getElementById("nextBtn")?.focus({ preventScroll: true });
  else if (matchMedia("(hover: hover)").matches) field.focus({ preventScroll: true });
}

function checkAnswer(giveUp = false) {
  const t = testRun;
  const q = t.questions[t.index];
  const typed = giveUp ? "" : (document.getElementById("answer")?.value ?? t.draft);
  if (!giveUp && !typed.trim()) return document.getElementById("answer")?.focus();
  // Typed with the Russian keyboard: say so instead of marking it wrong.
  if (!giveUp && /[а-яё]/i.test(typed)) {
    const field = document.getElementById("answer");
    field.classList.add("cyrillic");
    if (!document.getElementById("keyboardHint")) {
      field.after(h("p", { class: "keyboard-hint", id: "keyboardHint", role: "alert" }, "Похоже, включена русская клавиатура. Переключите её на английскую (кнопка с глобусом) и напишите ответ латиницей."));
    }
    return field.focus();
  }
  const result = checkWriting(q.en, typed);
  const before = progress[q.en];
  t.answers[t.index] = { typed, result, accepted: false, before };
  progress[q.en] = grade(before, result.correct);
  save("learnProgress", progress);
  if (countCard()) { t.celebrate = true; confetti(); }
  t.shownIndex = t.index; // same card, now marked
  renderTest(t.lesson);
}

// "My answer is right too": another correct way to say it.
function acceptAnswer() {
  const t = testRun;
  const a = t.answers[t.index];
  a.accepted = true;
  progress[t.questions[t.index].en] = grade(a.before, true);
  save("learnProgress", progress);
  renderTest(t.lesson);
}

function nextQuestion() {
  const t = testRun;
  stopSound();
  t.index++;
  t.draft = "";
  if (t.index >= t.questions.length) {
    const score = testScore(t);
    const previous = tests[t.lesson.id];
    t.previousBest = previous?.best ?? null;
    tests[t.lesson.id] = { best: Math.max(score, previous?.best ?? 0), last: score, total: t.questions.length, at: Date.now() };
    save("learnTests", tests);
  }
  renderTest(t.lesson);
  scrollTo(0, 0);
  // Focus within the tap, so a phone opens its keyboard for the next answer.
  document.getElementById("answer")?.focus({ preventScroll: true });
}

function renderTestResults() {
  const t = testRun;
  const { lesson } = t;
  const score = testScore(t);
  const total = t.questions.length;
  const perfect = score === total;
  const passed = score >= testNeed(total);
  const lessonDone = unitDone(lesson);
  const missed = t.questions.filter((q, i) => !isRight(t.answers[i]));
  const siblings = trackLessons(trackOf(lesson));
  const next = siblings[siblings.indexOf(lesson) + 1];
  document.title = `Результаты теста · ${lesson.title} · Курс английского`;
  if (!t.celebrated) { t.celebrated = true; if (passed) confetti(); }

  setView(
    h("div", { class: "nav" }, backLink(`#unit-${lesson.id}`, "Урок")),
    h("section", { class: "card done-card" },
      lessonDone || perfect ? lessonIcon("trophy", "done-mark") : passed ? h("span", { class: "done-mark" }, icon("check")) : lessonIcon("pencil-line", "done-mark soft"),
      h("p", { class: "eyebrow" }, `Тест · урок ${UNIT_NO.get(lesson.id)} · ${lesson.title}`),
      h("h1", { class: "num" }, `${score} из ${total}`),
      h("p", { class: "lede" },
        lessonDone ? `${perfect ? "Без единой ошибки! " : "Тест сдан. "}Урок ${UNIT_NO.get(lesson.id)} пройден.`
          : passed ? `Тест сдан${perfect ? " без единой ошибки" : ""}! Следующее задание — ${nextTask(lesson).title.toLowerCase()}.`
          : `Чтобы сдать тест, нужно ${testNeed(total)} из ${total}. Повторите ошибки карточками и попробуйте ещё раз.`),
      t.previousBest != null && t.previousBest !== score
        ? h("p", { class: "best num" }, score > t.previousBest ? `Новый рекорд! Было ${t.previousBest} из ${total}.` : `Лучший результат: ${t.previousBest} из ${total}.`)
        : null,
    ),
    h("section", { class: "card" },
      h("h2", {}, "Ответы"),
      h("ol", { class: "results" }, t.questions.map((q, i) => {
        const a = t.answers[i];
        const right = isRight(a);
        return h("li", {},
          h("span", { class: `mark${right ? "" : " no"}`, "aria-label": right ? "Верно" : "Ошибка" }, icon(right ? "check" : "x", right ? "i" : "u")),
          h("span", { class: "line-text" },
            h("span", { class: "ru-line" }, q.ru),
            !right && a.typed.trim() ? h("s", { class: "typed-line", lang: "en" }, h("span", { class: "visually-hidden" }, "Ваш ответ: "), a.typed) : null,
            h("span", { class: "en", lang: "en" }, q.en),
          ),
          playButton(q.en),
        );
      })),
    ),
    lessonTasks(lesson),
    ownSentenceCard(lesson),
    // The main button is whatever ticks the next box: the mistakes, the remaining phrases, or the next lesson.
    h("div", { class: "btn-stack" },
      missed.length
        ? h("button", { class: "btn primary", type: "button", onclick: () => practiseMistakes(lesson, missed) }, icon("repeat"), `Повторить ошибки · ${missed.length}`)
        : null,
      nextStepButton(lesson, !missed.length),
      h("button", { class: "btn", type: "button", onclick: () => { startTest(lesson); renderTest(lesson); scrollTo(0, 0); } }, icon("pencil-line", "u"), "Пройти тест ещё раз"),
      h("a", { class: "btn", href: `#${trackOf(lesson)}` }, "К курсу"),
    ),
  );
}

function practiseMistakes(lesson, missed) {
  mistakesDeck = { id: "mistakes", title: "Ошибки теста", back: `#unit-${lesson.id}`, backText: "Урок", phrases: missed, lesson };
  startSession(mistakesDeck);
  location.hash = "#practice-mistakes";
}

// ---- her own sentences, checked by Claude on the app's server
function ownSentenceCard(lesson) {
  if (!writingCheck) return null;
  const t = testRun;
  const example = lesson.phrases[(lesson.phrases.length * 0.5) | 0]?.en;
  const field = h("textarea", {
    class: "answer", id: "ownText", lang: "en", rows: "3", maxlength: "400", "aria-label": "Своё предложение по-английски",
    placeholder: example ? `Например: ${example}` : "Напишите по-английски", autocomplete: "off", autocorrect: "off",
    autocapitalize: "sentences", spellcheck: "false", enterkeyhint: "send",
    oninput: (e) => { t.ownDraft = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendOwnSentence(); } },
  });
  field.value = t.ownDraft;
  return h("section", { class: "card own-card", "aria-label": "Своё предложение" },
    h("h2", {}, "Своё предложение"),
    h("p", { class: "plan-note" }, `Напишите своё предложение на тему урока «${lesson.title}». Проверка исправит ошибки и объяснит правило по-русски.`),
    field,
    h("button", { class: "btn primary", type: "button", id: "ownBtn", onclick: () => sendOwnSentence() }, icon("check"), "Проверить"),
    h("ol", { class: "own", id: "ownList", "aria-live": "polite" }, ownItems()),
  );
}

const OWN_VERDICT = { correct: "Верно!", almost: "Почти", wrong: "Есть ошибка" };
function ownItems() {
  return testRun.own.map((item) => {
    if (item.state === "checking") return h("li", { class: "checking" }, h("span", { class: "mine", lang: "en" }, item.text), h("span", { class: "verdict" }, "Проверяем…"));
    if (item.state === "error") return h("li", { class: "bad" }, h("span", { class: "mine", lang: "en" }, item.text), h("span", { class: "verdict" }, item.error));
    const { verdict: v, corrected, explanation } = item.result;
    return h("li", { class: v === "correct" ? "good" : v === "almost" ? "almost" : "bad" },
      h("span", { class: "verdict" }, v === "correct" ? icon("check") : null, OWN_VERDICT[v] ?? v),
      v === "correct" ? null : h("s", { class: "mine", lang: "en" }, h("span", { class: "visually-hidden" }, "Вы написали: "), item.text),
      h("div", { class: "answer-line" }, playButton(corrected), h("span", { class: "line-text" },
        h("span", { class: "en", lang: "en" }, corrected),
        pronounceEnglish ? h("span", { class: "say", lang: "ru" }, pronounceEnglish(corrected)) : null)),
      h("p", { class: "why" }, explanation),
    );
  }).reverse(); // newest first
}
const refreshOwn = () => document.getElementById("ownList")?.replaceChildren(...ownItems());

let pronouncing = null;
function loadPronunciation() {
  pronouncing ??= import("./pronounce.js")
    .then(async ({ pronounce, loadDictionary }) => { await loadDictionary(); pronounceEnglish ??= (text) => pronounce(text, "en"); })
    .catch(() => { pronouncing = null; });
  return pronouncing;
}

async function sendOwnSentence() {
  const t = testRun;
  const field = document.getElementById("ownText");
  const text = (field?.value ?? "").trim();
  if (!text) return field?.focus();
  const item = { text, state: "checking" };
  t.own.push(item);
  t.ownDraft = "";
  field.value = "";
  refreshOwn();
  loadPronunciation();
  try {
    const res = await fetch("api/check-writing", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": accessCode() },
      body: JSON.stringify({ text, lesson: t.lesson.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Нужен код доступа: откройте субтитры и введите его.");
    if (res.status === 429) throw new Error("Слишком много проверок подряд. Подождите минуту.");
    if (!res.ok || !data.corrected) throw new Error("Не удалось проверить. Попробуйте ещё раз.");
    item.state = "done";
    item.result = data;
    await Promise.race([pronouncing, new Promise((r) => setTimeout(r, 1500))]); // pronunciation if it's quick
  } catch (err) {
    item.state = "error";
    item.error = err instanceof TypeError ? "Нет соединения. Попробуйте ещё раз." : err.message;
  }
  if (testRun === t) refreshOwn();
}

// ---------------------------------------------------------------- skills (#listen-cafe, #read-cafe, #speak-cafe)
// Three short exercises per lesson, eight phrases each, passed with 6 of 8:
// - listening: hear a phrase (no text) and pick what was said;
// - reading: read a phrase and pick its meaning;
// - speaking: say the Russian phrase in English. In the app speech recognition checks it; elsewhere
//   she says it aloud, looks at the answer and marks herself.
const DRILLS = {
  listen: { title: "Аудирование", icon: "headphones", ask: "Послушайте и выберите, что прозвучало." },
  read: { title: "Чтение", icon: "book-open-text", ask: "Прочитайте и выберите перевод." },
  speak: { title: "Говорение", icon: "mic", ask: "Скажите это по-английски вслух." },
};
let drill = null; // { kind, lesson, items, options, index, answers: [{ ok, choice }], revealed, feedback }

function startDrill(kind, lesson) {
  const items = testQuestions(lesson.phrases, TEST_SIZE);
  const options = items.map((q) => (kind === "listen" ? choices(q.en, lesson.phrases.map((p) => p.en)) : kind === "read" ? choices(q.ru, lesson.phrases.map((p) => p.ru)) : null));
  drill = { kind, lesson, items, options, index: 0, answers: [], revealed: false, feedback: null };
}

function renderDrill(kind, lesson) {
  if (drill?.kind !== kind || drill.lesson !== lesson) startDrill(kind, lesson);
  const d = drill;
  if (d.index >= d.items.length) return renderDrillResults();
  const info = DRILLS[kind];
  const q = d.items[d.index];
  const a = d.answers[d.index];
  const isNew = d.shownIndex !== d.index;
  d.shownIndex = d.index;
  const celebrate = d.celebrate;
  d.celebrate = null;
  document.title = `${info.title} · ${lesson.title} · Курс английского`;
  prefetch(q.en);
  prefetch(d.items[d.index + 1]?.en);

  const answerLine = () => h("div", { class: "drill-answer" }, playButton(q.en), h("span", { class: "line-text" },
    h("span", { class: "en", lang: "en" }, q.en), q.say ? h("span", { class: "say", lang: "ru" }, q.say) : null, h("span", { class: "ru" }, q.ru)));
  const options = (list, lang) => h("div", { class: "choices", role: "group", "aria-label": "Варианты ответа" },
    list.map((opt) => {
      const right = opt === (kind === "listen" ? q.en : q.ru);
      const state = a ? (right ? " right" : opt === a.choice ? " wrong" : "") : "";
      return h("button", { class: `choice${state}`, type: "button", lang, disabled: a ? true : null, onclick: () => answerDrill(opt === (kind === "listen" ? q.en : q.ru), opt) },
        a && right ? icon("check") : null, opt);
    }));

  let body;
  if (kind === "listen") {
    body = [
      h("p", { class: "hint" }, info.ask),
      canPlay()
        ? h("div", { class: "listen-row" },
            h("button", { class: "big-play", type: "button", "aria-label": "Послушать", onclick: (e) => speak(q.en, speed, e.currentTarget) }, icon("play")),
            h("button", { class: "btn small", type: "button", onclick: (e) => speak(q.en, 0.5, e.currentTarget) }, "Медленно"))
        : h("p", { class: "hint" }, "Озвучка недоступна в этом браузере."),
      options(d.options[d.index], "en"),
      a ? answerLine() : null,
    ];
  } else if (kind === "read") {
    body = [
      h("p", { class: "hint" }, info.ask),
      h("div", { class: "en-big", lang: "en" }, q.en),
      options(d.options[d.index], "ru"),
      a ? answerLine() : null,
    ];
  } else {
    const auto = Boolean(Recognizer);
    body = [
      h("p", { class: "hint" }, info.ask),
      h("div", { class: "ru-big" }, q.ru),
      d.feedback ? feedbackBlock(d.feedback) : null,
      d.revealed || a ? answerLine() : null,
      a && !auto ? h("div", { class: `self-mark ${a.ok ? "good" : "bad"}` }, a.ok ? [icon("check"), "Получилось"] : "Не получилось — в следующий раз получится") : null,
      h("div", { class: "tools" },
        auto ? h("button", { class: `btn${a ? "" : " primary"}`, type: "button", id: "drillSay", onclick: () => drillSpeak() }, icon("mic"), a ? "Сказать ещё раз" : "Сказать") : null,
        !auto && !d.revealed && !a ? h("button", { class: "btn primary", type: "button", onclick: () => { d.revealed = true; renderDrill(kind, lesson); } }, "Проверить себя") : null,
        auto && !d.revealed && !a ? h("button", { class: "btn", type: "button", onclick: () => { d.revealed = true; renderDrill(kind, lesson); } }, "Подсказка") : null,
      ),
      !auto && d.revealed && !a
        ? h("div", { class: "grade" },
            h("button", { class: "btn", type: "button", onclick: () => answerDrill(false) }, icon("repeat"), "Не вышло"),
            h("button", { class: "btn primary", type: "button", onclick: () => answerDrill(true) }, icon("check"), "Получилось"))
        : null,
      auto ? null : h("p", { class: "hint" }, "Скажите вслух, потом откройте ответ и честно отметьте себя."),
    ];
  }

  setView(
    h("div", { class: "nav" }, backLink(`#unit-${lesson.id}`, "Урок"), h("span", { class: "count num" }, `${d.index + 1} из ${d.items.length}`)),
    h("div", { class: "meter" }, h("i", { style: `width: ${(d.answers.length / d.items.length) * 100}%` })),
    celebrate
      ? h("div", { class: "celebrate", role: "status" }, lessonIcon("trophy", "celebrate-icon"),
          h("span", {}, h("b", {}, "Цель на сегодня выполнена!"), ` ${streakText(streak(stats.days))}.`))
      : null,
    h("section", { class: `card flash drill${isNew ? " enter" : ""}`, "aria-label": `${info.title}: ${lesson.title}` },
      h("div", { class: "flash-head" }, lessonIcon(info.icon, "tile small"), h("span", {}, `${info.title} · ${lesson.title}`)),
      body,
    ),
    a ? h("button", { class: "btn primary wide", type: "button", id: "nextBtn", onclick: () => nextDrillItem() }, d.index + 1 < d.items.length ? "Дальше" : "Результаты", icon("next")) : null,
    h("p", { class: "tip" }, kind === "listen" ? "Не получается разобрать? Нажмите «Медленно»." : kind === "read" ? "Не торопитесь: сначала прочитайте всю фразу." : "Говорите громко и чётко, как в разговоре."),
  );
  if (a) document.getElementById("nextBtn")?.focus({ preventScroll: true });
}

function answerDrill(ok, choice = null) {
  const d = drill;
  if (d.answers[d.index]) return;
  d.answers[d.index] = { ok, choice };
  if (countCard()) { d.celebrate = true; confetti(); }
  renderDrill(d.kind, d.lesson);
}

function nextDrillItem() {
  const d = drill;
  attempt?.cancel();
  stopSound();
  d.index++;
  d.revealed = false;
  d.feedback = null;
  if (d.index >= d.items.length) {
    const score = d.answers.filter((a) => a.ok).length;
    const mine = (skills[d.lesson.id] ??= {});
    d.previousBest = mine[d.kind]?.best ?? null;
    mine[d.kind] = { best: Math.max(score, mine[d.kind]?.best ?? 0), last: score, total: d.items.length, at: Date.now() };
    save("learnSkills", skills);
  }
  renderDrill(d.kind, d.lesson);
  scrollTo(0, 0);
  // Listening: play the next phrase within the tap, so phones allow the sound.
  if (d.kind === "listen" && d.index < d.items.length) speak(d.items[d.index].en, speed, document.querySelector(".big-play"));
}

async function drillSpeak() {
  const d = drill;
  if (attempt) return attempt.finish(); // second tap: done speaking
  const index = d.index;
  const q = d.items[index];
  d.feedback = { state: "listening", heard: "" };
  renderDrill(d.kind, d.lesson);
  const btn = document.getElementById("drillSay");
  btn?.replaceChildren(icon("stop"), "Готово");
  btn?.classList.add("rec");
  try {
    const heard = await listenOnce((text) => {
      const el = document.getElementById("interim");
      if (el) el.textContent = text;
    });
    if (drill !== d || d.index !== index || heard === null) return;
    const result = compareSpeech(q.en, heard);
    d.feedback = { state: "result", heard, result };
    const ok = result.score >= 0.8;
    if (!d.answers[index]) {
      d.answers[index] = { ok, score: result.score };
      if (countCard()) { d.celebrate = true; confetti(); }
    } else if (ok) d.answers[index].ok = true; // a better try counts
  } catch (err) {
    if (drill !== d) return;
    const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
    d.feedback = { state: "error", message: denied ? "Разрешите доступ к микрофону в настройках браузера и попробуйте снова." : err.message };
  }
  renderDrill(d.kind, d.lesson);
}

function renderDrillResults() {
  const d = drill;
  const { lesson, kind } = d;
  const info = DRILLS[kind];
  const score = d.answers.filter((a) => a.ok).length;
  const total = d.items.length;
  const passed = score >= testNeed(total);
  const lessonDone = unitDone(lesson);
  document.title = `${info.title}: результат · ${lesson.title} · Курс английского`;
  if (!d.celebrated) { d.celebrated = true; if (passed) confetti(); }
  const again = () => { startDrill(kind, lesson); renderDrill(kind, lesson); scrollTo(0, 0); };
  setView(
    h("div", { class: "nav" }, backLink(`#unit-${lesson.id}`, "Урок")),
    h("section", { class: "card done-card" },
      lessonDone ? lessonIcon("trophy", "done-mark") : lessonIcon(info.icon, `done-mark${passed ? "" : " soft"}`),
      h("p", { class: "eyebrow" }, `${info.title} · урок ${UNIT_NO.get(lesson.id)} · ${lesson.title}`),
      h("h1", { class: "num" }, `${score} из ${total}`),
      h("p", { class: "lede" },
        lessonDone ? `Все задания выполнены — урок ${UNIT_NO.get(lesson.id)} пройден!`
          : passed ? `Сдано! Следующее задание — ${nextTask(lesson).title.toLowerCase()}.`
          : `Нужно ${testNeed(total)} из ${total}. Попробуйте ещё раз — с каждым разом легче.`),
      d.previousBest != null && d.previousBest !== score
        ? h("p", { class: "best num" }, score > d.previousBest ? `Новый рекорд! Было ${d.previousBest} из ${total}.` : `Лучший результат: ${d.previousBest} из ${total}.`)
        : null,
    ),
    h("section", { class: "card" },
      h("h2", {}, "Ответы"),
      h("ol", { class: "results" }, d.items.map((q, i) => {
        const ok = d.answers[i]?.ok;
        return h("li", {},
          h("span", { class: `mark${ok ? "" : " no"}`, "aria-label": ok ? "Верно" : "Ошибка" }, icon(ok ? "check" : "x", ok ? "i" : "u")),
          h("span", { class: "line-text" }, h("span", { class: "en", lang: "en" }, q.en), h("span", { class: "ru-line" }, q.ru)),
          playButton(q.en));
      })),
    ),
    lessonTasks(lesson),
    h("div", { class: "btn-stack" },
      passed ? nextStepButton(lesson) : h("button", { class: "btn primary", type: "button", onclick: again }, icon("repeat"), "Ещё раз"),
      passed ? h("button", { class: "btn", type: "button", onclick: again }, icon("repeat"), "Ещё раз") : null,
      h("a", { class: "btn", href: `#unit-${lesson.id}` }, "К уроку"),
    ),
  );
}

// ---------------------------------------------------------------- navigation (#unit-cafe, #practice-cafe, #test-cafe, #listen-cafe…)
function route() {
  attempt?.cancel();
  stopSound();
  const hash = location.hash.slice(1);
  if (!hash.startsWith("test-")) testRun = null;
  const skill = /^(listen|read|speak)-(.+)$/.exec(hash);
  if (!skill) drill = null;
  if (skill) {
    const lesson = LESSONS.find((l) => l.id === skill[2]);
    if (lesson) { session = null; renderDrill(skill[1], lesson); return scrollTo(0, 0); }
  }
  if (hash === "grammar-plan") {
    session = null;
    renderGrammarPlan();
    return scrollTo(0, 0);
  }
  if (hash.startsWith("unit-")) {
    const lesson = LESSONS.find((l) => l.id === hash.slice(5));
    if (lesson) { session = null; renderUnit(lesson); return scrollTo(0, 0); }
  }
  if (hash.startsWith("practice-")) {
    const deck = deckFor(hash.slice(9));
    if (deck?.phrases.length) { renderPractice(deck); return scrollTo(0, 0); }
  }
  if (hash.startsWith("test-")) {
    const lesson = LESSONS.find((l) => l.id === hash.slice(5));
    if (lesson) { session = null; renderTest(lesson); return scrollTo(0, 0); }
  }
  session = null;
  renderCourse(TRACKS.some((t) => t.id === hash) ? hash : currentTrack);
  scrollTo(0, 0);
}
addEventListener("hashchange", route);
route();
showFoot();
detectApp();
