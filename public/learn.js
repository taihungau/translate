// The Learn page: an English course for a Russian speaker. Course → unit (goal, grammar,
// phrases) → practice cards, with a daily goal and a streak. In the subtitles app, phrases are
// read aloud by Deepgram's American voices and the speaking check listens with the same speech
// recognition as live subtitles.
import { TRACKS, LEVELS, LESSONS } from "./lessons.js";
import { compareSpeech, grade, isLearned, isDue, verdict, dayKey, streak } from "./learn-core.js";

const APP_URL = "https://translate-hyperlinks-projects.vercel.app/";
const view = document.getElementById("view");
const foot = document.getElementById("foot");

// The browser bar matches the page (the theme follows the phone unless Appearance is set in the app).
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function matchBrowserBar() {
  const theme = document.documentElement.dataset.theme;
  const dark = theme ? theme === "dark" : darkQuery.matches;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0c0d10" : "#f6f7f9");
}
matchBrowserBar();
darkQuery.addEventListener("change", matchBrowserBar);

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
const progress = load("learnProgress", {}); // English phrase → { box, due }
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
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
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
// only the fallback. A published copy plays the recordings published with it (LEARN_RECORDINGS).
const RECORDINGS = globalThis.LEARN_RECORDINGS ?? null;
const tts = "speechSynthesis" in window ? window.speechSynthesis : null;
const player = new Audio();
player.preload = "auto";
let serverTts = false; // set once the app's server says it can read aloud
let voiceChoice = load("learnVoice", "female"); // "female" (Thalia) or "male" (Orion)
const canPlay = () => Boolean(RECORDINGS || serverTts || tts);

const downloads = new Map(); // "voice|text" → { promise, url }
function download(text) {
  const key = `${voiceChoice}|${text}`;
  if (!downloads.has(key)) {
    let code = "";
    try { code = localStorage.getItem("accessCode") || ""; } catch { /* storage blocked */ }
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
const prefetch = (text) => { if (serverTts && text) download(text).promise.catch(() => {}); };

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

/** Read `text` aloud in American English. `rate`: 1 normal, 0.7 slow. */
async function speak(text, rate = 1, button = null) {
  if (!text) return;
  tts?.cancel();
  player.pause();
  markPlaying(button);
  try {
    if (RECORDINGS?.[text]) return await playFile(RECORDINGS[text], rate);
    if (serverTts) {
      const entry = download(text);
      if (entry.url) return await playFile(entry.url, rate); // downloaded already: plays within the tap
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
    onclick: (e) => speak(text, 1, e.currentTarget),
  }, icon("play"));
}

// English words that can be tapped to hear one at a time.
function tappableWords(text) {
  if (!canPlay()) return [text];
  return text.split(/(\s+)/).map((part) => {
    if (!part.trim()) return part;
    const word = part.replace(/[^\p{L}\p{N}'’-]/gu, "");
    return h("button", { class: "w", type: "button", onpointerdown: () => prefetch(word), onclick: () => speak(word, 0.9) }, part);
  });
}

// ---------------------------------------------------------------- in the subtitles app
// On the app's own server the page can check pronunciation (speech recognition needs the app's
// server for its key) and review phrases heard in films. A published copy has neither.
let inApp = false;
let Recognizer = null;
let pronounceEnglish = null;

async function detectApp() {
  try {
    const res = await fetch("api/config", { cache: "no-store" });
    const config = await res.json();
    inApp = true;
    serverTts = Boolean(config.tts);
    if (config.cloudSpeech) ({ CloudRecognizer: Recognizer } = await import("./cloud-asr.js"));
    if (load("heardPhrases", []).length) {
      const { pronounce, loadDictionary } = await import("./pronounce.js");
      await loadDictionary();
      pronounceEnglish = (text) => pronounce(text, "en");
    }
  } catch {
    return; // not served by the app
  }
  // Show what just became available, without restarting a practice session in progress.
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
  let code = "";
  try { code = localStorage.getItem("accessCode") || ""; } catch { /* storage blocked */ }
  const res = await fetch("api/speech-token", { method: "POST", headers: { "X-Access-Code": code } });
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
    ),
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
const PHRASE_LESSON = new Map(LESSONS.flatMap((lesson) => lesson.phrases.map((p) => [p.en, lesson])));
const levelOf = (lesson) => LEVELS.find((l) => l.id === lesson.level);
const trackOf = (lesson) => levelOf(lesson).track;
const trackLessons = (track) => LESSONS.filter((lesson) => trackOf(lesson) === track);
// Units are numbered within their track: Каждый день 1–30, Грамматика 1–16, Работа 1–16.
const UNIT_NO = new Map(TRACKS.flatMap((t) => trackLessons(t.id).map((lesson, i) => [lesson.id, i + 1])));
const knownOnce = (phrase) => (progress[phrase.en]?.box ?? 0) >= 1;
const unitDone = (lesson) => lesson.phrases.every(knownOnce);
const nextLesson = (track) => trackLessons(track).find((lesson) => !unitDone(lesson));
let currentTrack = TRACKS.some((t) => t.id === load("learnTrack", "")) ? load("learnTrack", "") : TRACKS[0].id;

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
  const started = (lesson) => lesson.phrases.some(knownOnce);

  view.replaceChildren(
    h("div", { class: "nav" },
      inApp ? backLink("./", "Субтитры") : h("a", { class: "back", href: APP_URL, target: "_blank", rel: "noopener" }, icon("back"), "Субтитры"),
    ),
    h("header", {},
      h("h1", {}, "Курс английского"),
      h("p", { class: "lede" }, `${LESSONS.length} ${plural(LESSONS.length, "урок", "урока", "уроков")} в трёх разделах. Каждая фраза — с переводом и произношением русскими буквами; её можно послушать и повторить вслух.`),
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
      h("div", { class: "meter" }, h("i", { style: `width: ${(practised / phrases.length) * 100}%` })),
      practised ? h("p", { class: "summary-note" }, `Закреплено повторением: ${learned}. Пройденные фразы возвращаются через день, 3 дня, неделю и дольше.`) : null,
      h("div", { class: "btn-row" },
        next
          ? h("a", { class: "btn primary", href: `#unit-${next.id}` }, `${started(next) || practised ? "Продолжить" : "Начать"}: урок ${UNIT_NO.get(next.id)}`, icon("next"))
          : h("span", { class: "btn" }, "Все уроки раздела пройдены"),
        due ? h("a", { class: "btn", href: "#practice-review" }, icon("repeat"), `Повторить · ${due}`) : null,
      ),
    ),
    ...LEVELS.filter((level) => level.track === track).map((level) =>
      h("section", { class: "level", "aria-label": level.title },
        h("div", { class: "level-head" }, h("span", { class: "badge" }, level.badge ?? level.id), h("h3", {}, level.title)),
        h("p", { class: "level-about" }, level.about),
        h("ol", { class: "units" },
          LESSONS.filter((lesson) => lesson.level === level.id).map((lesson) => {
            const known = lesson.phrases.filter(knownOnce).length;
            const done = known === lesson.phrases.length;
            return h("li", {},
              h("a", { class: `unit${done ? " done" : ""}${lesson === next ? " next" : ""}`, href: `#unit-${lesson.id}` },
                lessonIcon(lesson.icon),
                h("span", { class: "unit-text" },
                  h("b", {}, lesson.title),
                  h("small", {}, `${UNIT_NO.get(lesson.id)} · ${lesson.en} · `, h("span", { class: "num" }, done ? "пройдено" : `${known} из ${lesson.phrases.length}`)),
                  known && !done ? h("span", { class: "mini-meter" }, h("i", { style: `width: ${(known / lesson.phrases.length) * 100}%` })) : null,
                ),
                done ? h("span", { class: "unit-done", "aria-label": "Пройдено" }, icon("check")) : icon("next"),
              ),
            );
          }),
        ),
      ),
    ),
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

function renderUnit(lesson) {
  const level = levelOf(lesson);
  const track = TRACKS.find((t) => t.id === level.track);
  const isGrammar = Boolean(lesson.table);
  document.title = `${lesson.title} · Курс английского`;
  const line = (en, say, ru) => h("span", { class: "line-text" },
    h("span", { class: "en", lang: "en" }, en),
    say ? h("span", { class: "say", lang: "ru" }, say) : null,
    h("span", { class: "ru" }, ru));

  view.replaceChildren(
    h("div", { class: "nav" }, backLink(`#${track.id}`, track.title)),
    h("header", { class: "unit-head" },
      lessonIcon(lesson.icon, "tile big"),
      h("div", {},
        h("p", { class: "eyebrow" }, [track.title, `урок ${UNIT_NO.get(lesson.id)}`, level.badge ?? level.id].filter((x, i, all) => all.indexOf(x) === i).join(" · ")),
        h("h1", {}, lesson.title),
        h("p", { class: "lede" }, `Цель: ${lesson.goal[0].toLowerCase()}${lesson.goal.slice(1)}`),
      ),
    ),
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
      h("h2", {}, `${isGrammar ? "Примеры" : "Фразы урока"} · ${lesson.phrases.length}`),
      h("ol", { class: "phrase-list" }, lesson.phrases.map((p) => h("li", {}, playButton(p.en), line(p.en, p.say, p.ru)))),
    ),
    h("a", { class: "btn primary wide", href: `#practice-${lesson.id}` }, "Начать практику", icon("next")),
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

  view.replaceChildren(
    h("div", { class: "nav" },
      backLink(deck.back, deck.lesson ? "Урок" : "Курс"),
      h("span", { class: "count num" }, `${Math.min(s.index + 1, s.queue.length)} из ${s.queue.length}`),
    ),
    h("div", { class: "meter" }, h("i", { style: `width: ${(s.index / s.queue.length) * 100}%` })),
    h("div", { class: "modes", role: "radiogroup", "aria-label": "Режим" },
      h("button", { type: "button", role: "radio", "aria-checked": String(understand), onclick: () => setMode("understand") }, "Понимать"),
      h("button", { type: "button", role: "radio", "aria-checked": String(!understand), onclick: () => setMode("speak") }, "Говорить"),
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
        canPlay() ? h("button", { class: "btn", type: "button", onclick: (e) => speak(p.en, 1, e.currentTarget) }, icon("play"), "Слушать") : null,
        canPlay() ? h("button", { class: "btn", type: "button", onclick: (e) => speak(p.en, 0.7, e.currentTarget) }, icon("slow"), "Медленно") : null,
        h("button", { class: "btn", type: "button", id: "sayBtn", "data-needs-app": "", hidden: !Recognizer, onclick: () => checkSpeech(p) }, icon("mic"), "Сказать"),
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
  const done = lesson && unitDone(lesson);
  if (!session.celebrated) { session.celebrated = true; confetti(); }
  const siblings = lesson ? trackLessons(trackOf(lesson)) : [];
  const next = lesson && siblings[siblings.indexOf(lesson) + 1];
  const courseHash = lesson ? `#${trackOf(lesson)}` : `#${currentTrack}`;
  view.replaceChildren(
    h("div", { class: "nav" }, backLink(courseHash, "Курс")),
    h("section", { class: "card done-card" },
      done ? lessonIcon("trophy", "done-mark") : h("span", { class: "done-mark" }, icon("check")),
      h("h1", {}, done ? `Урок ${UNIT_NO.get(lesson.id)} пройден` : "Готово"),
      h("div", { class: "done-stats" },
        h("span", {}, h("b", { class: "num" }, knew), "знаю"),
        h("span", {}, h("b", { class: "num" }, again), "повторили"),
        h("span", {}, h("b", { class: "num" }, streak(stats.days)), plural(streak(stats.days), "день подряд", "дня подряд", "дней подряд")),
      ),
      h("p", { class: "lede" }, done ? "Фразы вернутся на повторение через день, потом через 3 дня, неделю и дольше." : "Пройдите урок ещё раз, чтобы закрепить все фразы."),
    ),
    h("div", { class: "btn-row" },
      next && done ? h("a", { class: "btn primary", href: `#unit-${next.id}` }, `Урок ${UNIT_NO.get(next.id)}: ${next.title}`, icon("next")) : null,
      h("button", { class: "btn", type: "button", onclick: () => { startSession(deckFor(deck.id) ?? deck); renderPractice(session.deck); } }, icon("repeat"), "Ещё раз"),
      h("a", { class: "btn", href: courseHash }, "К курсу"),
    ),
  );
}

// ---------------------------------------------------------------- navigation (#unit-cafe, #practice-cafe)
function route() {
  attempt?.cancel();
  stopSound();
  const hash = location.hash.slice(1);
  if (hash.startsWith("unit-")) {
    const lesson = LESSONS.find((l) => l.id === hash.slice(5));
    if (lesson) { session = null; renderUnit(lesson); return scrollTo(0, 0); }
  }
  if (hash.startsWith("practice-")) {
    const deck = deckFor(hash.slice(9));
    if (deck?.phrases.length) { renderPractice(deck); return scrollTo(0, 0); }
  }
  session = null;
  renderCourse(TRACKS.some((t) => t.id === hash) ? hash : currentTrack);
  scrollTo(0, 0);
}
addEventListener("hashchange", route);
route();
showFoot();
detectApp();
