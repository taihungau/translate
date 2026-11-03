// The Learn page: an English course for a Russian speaker. Course → unit (goal, grammar,
// phrases) → practice cards. Phrases are read aloud by the device's English voice; in the
// subtitles app, the speaking check listens with the same speech recognition as live subtitles.
import { LEVELS, LESSONS } from "./lessons.js";
import { compareSpeech, grade, isLearned, isDue, verdict } from "./learn-core.js";

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

// ---------------------------------------------------------------- listening (the device's voice)
const tts = "speechSynthesis" in window ? window.speechSynthesis : null;
let voice = null;
function pickVoice() {
  const english = tts.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  const rank = (v) =>
    (/^en[-_]US/i.test(v.lang) ? 3 : /^en[-_]GB/i.test(v.lang) ? 2 : 0) +
    (/natural|neural|premium|enhanced|samantha|google us english|aria|jenny/i.test(v.name) ? 3 : 0) +
    (v.localService ? 1 : 0);
  voice = english.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}
if (tts) {
  pickVoice();
  tts.addEventListener?.("voiceschanged", pickVoice);
}
function speak(text, rate = 0.95) {
  if (!tts || !text) return;
  tts.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang ?? "en-US";
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  tts.speak(utterance);
}
const playButton = (text, label = "Слушать") =>
  tts ? h("button", { class: "play", type: "button", "aria-label": `${label}: ${text}`, onclick: () => speak(text) }, icon("play")) : null;

// English words that can be tapped to hear one at a time.
function tappableWords(text) {
  if (!tts) return [text];
  return text.split(/(\s+)/).map((part) => {
    if (!part.trim()) return part;
    const word = part.replace(/[^\p{L}\p{N}'’-]/gu, "");
    return h("button", { class: "w", type: "button", onclick: () => speak(word, 0.8) }, part);
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
  else for (const el of document.querySelectorAll("[data-needs-app]")) el.hidden = false;
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
  tts?.cancel();
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

// ---------------------------------------------------------------- course data
const UNIT_NO = new Map(LESSONS.map((lesson, i) => [lesson.id, i + 1]));
const ALL_PHRASES = LESSONS.flatMap((lesson) => lesson.phrases);
const knownOnce = (phrase) => (progress[phrase.en]?.box ?? 0) >= 1;
const unitDone = (lesson) => lesson.phrases.every(knownOnce);
const nextLesson = () => LESSONS.find((lesson) => !unitDone(lesson));

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
    return { id, title: "Повторение", back: "#", phrases: due.slice(0, 30) };
  }
  if (id === "films") return { id, title: "Фразы из фильмов", back: "#", phrases: filmPhrases().slice(0, 40) };
  const lesson = LESSONS.find((l) => l.id === id);
  return lesson && { id, title: lesson.title, back: `#unit-${id}`, phrases: lesson.phrases, lesson };
}

// ---------------------------------------------------------------- views
function renderCourse() {
  document.title = "Курс английского";
  const practised = ALL_PHRASES.filter(knownOnce).length;
  const learned = ALL_PHRASES.filter((p) => isLearned(progress[p.en])).length;
  const now = Date.now();
  const due = [...ALL_PHRASES, ...filmPhrases()].filter((p) => isDue(progress[p.en], now)).length;
  const next = nextLesson();
  const films = load("heardPhrases", []).length;

  view.replaceChildren(
    h("div", { class: "nav" },
      inApp ? backLink("./", "Субтитры") : h("a", { class: "back", href: APP_URL, target: "_blank", rel: "noopener" }, icon("back"), "Субтитры"),
    ),
    h("header", {},
      h("h1", {}, "Курс английского"),
      h("p", { class: "lede" }, "Двенадцать уроков от первых фраз до свободного разговора. Каждая фраза — с переводом и произношением русскими буквами; её можно послушать и повторить."),
    ),
    h("section", { class: "card summary", "aria-label": "Прогресс" },
      h("div", { class: "summary-stat" },
        h("b", { class: "num" }, practised),
        h("span", {}, `из ${ALL_PHRASES.length} ${plural(ALL_PHRASES.length, "фразы", "фраз", "фраз")} пройдено`),
      ),
      h("div", { class: "meter" }, h("i", { style: `width: ${(practised / ALL_PHRASES.length) * 100}%` })),
      h("p", { class: "summary-note" }, practised
        ? `Закреплено повторением: ${learned}. Пройденные фразы возвращаются на повторение через день, 3 дня, неделю и дольше.`
        : "Начните с первого урока. Уроки идут по порядку, от простого к сложному."),
      h("div", { class: "btn-row" },
        next
          ? h("a", { class: "btn primary", href: `#unit-${next.id}` }, `${UNIT_NO.get(next.id) === 1 && !next.phrases.some(knownOnce) ? "Начать" : "Продолжить"}: урок ${UNIT_NO.get(next.id)}`, icon("next"))
          : h("span", { class: "btn" }, "Все уроки пройдены"),
        due ? h("a", { class: "btn", href: "#practice-review" }, icon("repeat"), `Повторить · ${due}`) : null,
      ),
    ),
    ...LEVELS.map((level) =>
      h("section", { class: "level", "aria-label": `Уровень ${level.id}` },
        h("div", { class: "level-head" }, h("span", { class: "badge" }, level.id), h("h3", {}, level.title)),
        h("p", { class: "level-about" }, level.about),
        h("ol", { class: "units" },
          LESSONS.filter((lesson) => lesson.level === level.id).map((lesson) => {
            const known = lesson.phrases.filter(knownOnce).length;
            const done = known === lesson.phrases.length;
            return h("li", {},
              h("a", { class: `unit${done ? " done" : ""}${lesson === next ? " next" : ""}`, href: `#unit-${lesson.id}` },
                h("span", { class: "unit-no", "aria-hidden": "true" }, done ? icon("check") : UNIT_NO.get(lesson.id)),
                h("span", { class: "unit-text" },
                  h("b", {}, lesson.title),
                  h("small", {}, `${lesson.en} · `, h("span", { class: "num" }, `${known} из ${lesson.phrases.length}`)),
                ),
                icon("next"),
              ),
            );
          }),
        ),
      ),
    ),
    films
      ? h("section", { class: "level", "aria-label": "Из фильмов" },
          h("div", { class: "level-head" }, h("h3", {}, "Из ваших фильмов")),
          h("p", { class: "level-about" }, "Фразы, которые прозвучали в режиме живых субтитров."),
          h("ol", { class: "units" }, h("li", {},
            h("a", { class: "unit", href: "#practice-films" },
              h("span", { class: "unit-no", "aria-hidden": "true" }, icon("film")),
              h("span", { class: "unit-text" }, h("b", {}, "Фразы из фильмов"), h("small", { class: "num" }, `${films} ${plural(films, "фраза", "фразы", "фраз")}`)),
              icon("next"),
            ),
          )),
        )
      : null,
  );
}

function renderUnit(lesson) {
  const no = UNIT_NO.get(lesson.id);
  const level = LEVELS.find((l) => l.id === lesson.level);
  document.title = `${lesson.title} · Курс английского`;
  view.replaceChildren(
    h("div", { class: "nav" }, backLink("#", "Курс")),
    h("header", {},
      h("p", { class: "eyebrow" }, `Урок ${no} · ${level.id} ${level.title}`),
      h("h1", {}, lesson.title),
      h("p", { class: "lede" }, `Цель: ${lesson.goal[0].toLowerCase()}${lesson.goal.slice(1)}`),
    ),
    h("section", { class: "card grammar" },
      h("h2", {}, "Грамматика"),
      h("p", {}, lesson.grammar),
      h("ul", { class: "examples" }, lesson.examples.map((ex) =>
        h("li", {}, playButton(ex.en), h("span", { class: "line-text" }, h("span", { class: "en", lang: "en" }, ex.en), h("span", { class: "ru" }, ex.ru))),
      )),
    ),
    h("section", { class: "card" },
      h("h2", {}, `Фразы урока · ${lesson.phrases.length}`),
      h("ol", { class: "phrase-list" }, lesson.phrases.map((p) =>
        h("li", {}, playButton(p.en),
          h("span", { class: "line-text" },
            h("span", { class: "en", lang: "en" }, p.en),
            h("span", { class: "say", lang: "ru" }, p.say),
            h("span", { class: "ru" }, p.ru),
          ),
        ),
      )),
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

  const english = [h("div", { class: "en-big", lang: "en" }, tappableWords(p.en)), p.say ? h("div", { class: "say", lang: "ru" }, p.say) : null];
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
    h("section", { class: "card flash", "aria-label": deck.title },
      h("div", { class: "front" }, front),
      s.revealed
        ? h("div", { class: "back" }, back)
        : h("button", { class: "btn reveal", type: "button", onclick: () => { s.revealed = true; renderPractice(deck); } }, understand ? "Показать перевод" : "Показать ответ"),
      h("div", { class: "tools" },
        tts ? h("button", { class: "btn", type: "button", onclick: () => speak(p.en) }, icon("play"), "Слушать") : null,
        tts ? h("button", { class: "btn", type: "button", onclick: () => speak(p.en, 0.6) }, icon("slow"), "Медленно") : null,
        h("button", { class: "btn", type: "button", id: "sayBtn", "data-needs-app": "", hidden: !Recognizer, onclick: () => checkSpeech(p) }, icon("mic"), "Сказать"),
      ),
      feedbackBlock(s.feedback),
    ),
    h("div", { class: "grade" },
      h("button", { class: "btn", type: "button", onclick: () => gradeCard(false) }, "Ещё раз"),
      h("button", { class: "btn primary", type: "button", onclick: () => gradeCard(true) }, "Знаю"),
    ),
    h("p", { class: "tip" }, tts ? "Нажмите на английское слово, чтобы услышать его отдельно." : "Озвучка недоступна в этом браузере."),
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
  s.index++;
  s.revealed = false;
  s.feedback = null;
  tts?.cancel();
  renderPractice(s.deck);
}

function renderDone() {
  const { deck, knew, again } = session;
  const lesson = deck.lesson;
  const done = lesson && unitDone(lesson);
  const next = lesson && LESSONS[LESSONS.indexOf(lesson) + 1];
  view.replaceChildren(
    h("div", { class: "nav" }, backLink("#", "Курс")),
    h("section", { class: "card done-card" },
      h("span", { class: "done-mark" }, icon("check")),
      h("h1", {}, done ? `Урок ${UNIT_NO.get(lesson.id)} пройден` : "Готово"),
      h("p", { class: "lede" }, `Знаю: ${knew}. Повторили: ${again}. ${done ? "Фразы вернутся на повторение через день, потом через 3 дня, неделю и дольше." : "Пройдите урок ещё раз, чтобы закрепить все фразы."}`),
    ),
    h("div", { class: "btn-row" },
      next && done ? h("a", { class: "btn primary", href: `#unit-${next.id}` }, `Урок ${UNIT_NO.get(next.id)}: ${next.title}`, icon("next")) : null,
      h("button", { class: "btn", type: "button", onclick: () => { startSession(deckFor(deck.id) ?? deck); renderPractice(session.deck); } }, icon("repeat"), "Ещё раз"),
      h("a", { class: "btn", href: "#" }, "К курсу"),
    ),
  );
}

// ---------------------------------------------------------------- navigation (#unit-cafe, #practice-cafe)
function route() {
  attempt?.cancel();
  tts?.cancel();
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
  renderCourse();
  scrollTo(0, 0);
}
addEventListener("hashchange", route);
route();
showFoot();
detectApp();
