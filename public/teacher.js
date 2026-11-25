// The AI English teacher: the app's main page (#teacher). She talks with the learner in real
// time, in English and Russian, about her life, in games and role-plays, and through the course's
// lessons, asking a question in nearly every turn.
//
// The loop: the microphone streams to Deepgram (teacher-asr.js), which says when her turn is
// over; her words go to /api/teacher, where Claude writes the teacher's answer as short tagged
// lines (see lib/teacher.js) that stream back; each spoken line is read aloud as soon as it is
// complete (teacher-voice.js), by an American voice in English and a Russian voice in Russian,
// with the face's lips following; cards, answer buttons, corrections and stars appear as the
// line that brings them is said. When she starts talking over the teacher, the teacher stops.
import { avatarStage, avatarSay, avatarHush, avatarMood, avatarThink, avatarListen } from "./avatar.js";
import { spreadWords } from "./learn-core.js";
import { LineSplitter, parseLine, splitForVoice, isEcho, conversation, herTurn, rememberNote } from "./teacher-core.js";
import { TeacherEars } from "./teacher-asr.js";
import { TeacherVoice } from "./teacher-voice.js";

export const TEACHER_MODES = [
  { id: "lesson", label: "Урок дня", icon: "book-open" },
  { id: "chat", label: "Болтаем", icon: "message-circle" },
  { id: "games", label: "Игры", icon: "party-popper" },
  { id: "roleplay", label: "Сценки", icon: "clapperboard" },
  { id: "review", label: "Повторение", icon: "repeat" },
];
const SCENES = [
  ["Кафе", "a café: you are the barista, she orders"],
  ["Салон красоты", "a beauty salon: she is the cosmetologist, you are a new client"],
  ["Отель", "a hotel: she checks in, you are the receptionist"],
  ["Аэропорт", "an airport: check-in and passport control"],
  ["Магазин", "a clothes shop: she is shopping, you are the shop assistant"],
  ["У врача", "a doctor's visit: she is the patient"],
  ["Свидание", "a first date in a restaurant"],
  ["Собеседование", "a job interview: you interview her"],
];
const NAMES = { female: { ru: "Эмма", en: "Emma" }, male: { ru: "Алекс", en: "Alex" } };
const SILENCE_MS = 20000; // quiet this long after the teacher spoke: she gently asks again
const MAX_LOG = 40;

let ctx = null; // what learn.js lends: state and helpers of the course
const T = {
  started: false,
  status: "idle", // idle | connecting | listening | hearing | thinking | speaking | muted | paused | typing
  mode: "lesson",
  scene: null,
  messages: [], // the conversation sent to Claude: { role, content }
  notes: [],
  stars: 0,
  log: [], // what the captions show: { who: "teacher" | "her", text, lang, live }
  extras: { card: null, fix: null, choices: null },
  turn: null, // the teacher's answer in progress
  ears: null,
  voice: null,
  stream: null,
  micOn: false,
  muted: false,
  typing: false,
  slow: false,
  error: null,
  silence: null,
  askedSilence: false,
  learnedNow: new Set(),
  leftAt: 0,
  el: {},
};

/** learn.js hands over what the teacher needs from the course, once. */
export function initTeacher(course) {
  ctx = course;
  T.mode = TEACHER_MODES.some((m) => m.id === ctx.load("teacherMode", "lesson")) ? ctx.load("teacherMode", "lesson") : "lesson";
  T.notes = ctx.load("teacherNotes", []);
  T.slow = ctx.load("teacherSlow", false);
  const today = ctx.load("teacherStars", {});
  T.stars = today[ctx.dayKey()] ?? 0;
}

const name = () => NAMES[ctx.voice()] ?? NAMES.female;
const h = (...a) => ctx.h(...a);
const put = (el, ...parts) => el.replaceChildren(...parts.flat().filter((part) => part != null && part !== false));

// ---------------------------------------------------------------- the page
export function renderTeacher() {
  document.title = `${name().ru} · учитель английского`;
  const { icon } = ctx;
  const el = T.el;
  el.status = h("div", { class: "t-status", role: "status" });
  el.level = h("span", { class: "t-meter", "aria-hidden": "true" });
  el.stars = h("span", { class: "t-stars num", "aria-label": "Звёзды за сегодня" });
  el.log = h("div", { class: "t-log", "aria-live": "polite" });
  el.extras = h("div", { class: "t-extras" });
  el.modes = h("div", { class: "t-modes", role: "radiogroup", "aria-label": "Чем займёмся" });
  el.scenes = h("div", { class: "t-scenes" });
  el.main = h("button", { class: "t-main", type: "button", onclick: mainButton });
  el.keys = h("button", { class: "t-side", type: "button", "aria-label": "Написать вместо того, чтобы говорить", onclick: () => toggleTyping() }, icon("pencil-line", "u"));
  el.slow = h("button", { class: "t-side t-speed num", type: "button", "aria-label": "Скорость речи учителя", onclick: toggleSlow });
  el.input = h("input", { class: "t-input", type: "text", placeholder: "Напиши по-английски или по-русски…", autocomplete: "off", enterkeyhint: "send", "aria-label": "Твой ответ" });
  el.form = h("form", { class: "t-type", onsubmit: (e) => { e.preventDefault(); typed(); } },
    el.input, h("button", { class: "t-send", type: "submit", "aria-label": "Отправить" }, icon("next")));
  el.face = ctx.canDrawFace()
    ? h("div", { class: "avatar-card t-face" },
        avatarStage(ctx.voice()),
        h("a", { class: "avatar-tool avatar-look", href: "#look", "aria-label": "Внешность учителя" }, icon("palette", "u")),
        el.status)
    : h("div", { class: "t-face t-noface" }, h("div", { class: "t-noface-name" }, name().ru), el.status);

  ctx.setView(h("div", { class: "teacher" },
    h("header", { class: "t-head" },
      h("div", {},
        h("h1", {}, name().ru),
        h("p", { class: "t-sub" }, `Учитель английского · уровень ${ctx.level()}`)),
      h("div", { class: "t-head-right" }, el.stars, ctx.themeToggle())),
    el.face,
    el.modes,
    el.scenes,
    el.log,
    el.extras,
    h("div", { class: "t-controls" }, el.slow, el.main, el.keys),
    el.form,
  ));
  T.voice?.setVoice(ctx.voice());
  paint();
  if (T.started && T.status === "paused") resume();
}

/** Called when another screen opens: the teacher stops and the microphone is let go. */
export function leaveTeacher() {
  if (!T.started || T.status === "paused") return;
  interrupt({ quiet: true });
  stopListening();
  T.status = "paused";
  T.leftAt = Date.now();
}

function paint() {
  const { icon, lessonIcon } = ctx;
  const el = T.el;
  if (!el.status?.isConnected) return;
  const n = name().ru;
  const words = {
    idle: "Нажми «Начать» и просто говори",
    connecting: "Подключаюсь…",
    listening: "Слушаю. Можно по-английски и по-русски",
    hearing: "Слышу тебя…",
    thinking: `${n} думает…`,
    speaking: `Говорит ${n}`,
    muted: "Микрофон выключен",
    paused: "Пауза",
    typing: "Напиши ответ внизу",
  };
  put(el.status,
    h("span", { class: `t-dot ${T.status}` }),
    T.error ?? words[T.status] ?? "",
    T.status === "listening" || T.status === "hearing" ? el.level : null);
  el.status.classList.toggle("error", Boolean(T.error));
  el.stars.replaceChildren(ctx.icon("star", "u"), String(T.stars));

  el.modes.replaceChildren(...TEACHER_MODES.map((m) => h("button", {
    class: "t-mode", type: "button", role: "radio", "aria-checked": String(T.mode === m.id),
    onclick: () => pickMode(m.id),
  }, lessonIcon(m.icon, "chip-icon"), m.label)));
  el.scenes.hidden = T.mode !== "roleplay";
  el.scenes.replaceChildren(...SCENES.map(([label, scene]) => h("button", {
    class: `t-scene${T.scene === scene ? " on" : ""}`, type: "button", onclick: () => pickScene(scene, label),
  }, label)));

  const main = {
    idle: ["t-main t-start", icon("play"), "Начать урок"],
    paused: ["t-main t-start", icon("play"), "Продолжить"],
    connecting: ["t-main t-busy", icon("mic"), "Подключаюсь"],
    listening: ["t-main t-on", icon("mic"), "Выключить микрофон"],
    hearing: ["t-main t-on t-hear", icon("check"), "Я договорила"],
    thinking: ["t-main t-busy", icon("mic"), `${n} думает`],
    speaking: ["t-main t-talk", icon("stop"), "Перебить"],
    muted: ["t-main t-off", icon("mic"), "Включить микрофон"],
    typing: ["t-main t-off", icon("mic"), "Включить микрофон"],
  }[T.status] ?? ["t-main", icon("mic"), ""];
  el.main.className = main[0];
  el.main.replaceChildren(main[1], h("span", { class: T.started && T.status !== "paused" ? "visually-hidden" : "" }, main[2]));
  el.main.setAttribute("aria-label", main[2]);
  el.main.disabled = T.status === "connecting" || T.status === "thinking" || (!T.started && !ctx.available().ready);
  el.slow.textContent = T.slow ? "0,8×" : "1×";
  el.slow.setAttribute("aria-pressed", String(T.slow));
  el.form.hidden = !(T.typing || (T.started && !T.micOn));
  el.keys.setAttribute("aria-pressed", String(!el.form.hidden));
  paintLog();
  paintExtras();
}

function paintLog() {
  const el = T.el.log;
  if (!el?.isConnected) return;
  if (!T.log.length) {
    const { app, ready } = ctx.available();
    const hint = !app ? "Учитель работает в приложении: там есть сервер с распознаванием речи и Claude."
      : !ready ? "Учитель ещё не подключён: на сервере нужны ключи Claude (ANTHROPIC_API_KEY) и Deepgram (DEEPGRAM_API_KEY)."
      : T.started ? "" : `${name().ru} спросит тебя о чём-нибудь, а ты отвечай вслух — как получится. Можно по-русски, можно по-английски. Ошибаться можно и нужно!`;
    put(el, hint ? h("p", { class: "t-hint" }, hint) : null);
    return;
  }
  put(el, T.log.map((item) => h("p", {
    class: `t-line ${item.who}${item.live ? " live" : ""}`, lang: item.lang ?? null,
  }, item.text)));
  el.scrollTop = el.scrollHeight;
}

function paintExtras() {
  const el = T.el.extras;
  if (!el?.isConnected) return;
  const { card, fix, choices } = T.extras;
  put(el,
    fix ? h("div", { class: "t-fix" },
      fix.wrong ? h("s", {}, fix.wrong) : null, fix.wrong ? " → " : null, h("b", { lang: "en" }, fix.right)) : null,
    card ? h("div", { class: "t-card" },
      h("div", { class: "t-card-en", lang: "en" }, card.en),
      card.say ? h("div", { class: "t-card-say" }, card.say) : null,
      card.ru ? h("div", { class: "t-card-ru" }, card.ru) : null) : null,
    choices ? h("div", { class: "t-choices" }, choices.map((option) => h("button", {
      class: "t-choice", type: "button", onclick: () => tapped(option),
    }, option))) : null,
  );
}

function setStatus(status) {
  if (T.status === status) return;
  T.status = status;
  if (status !== "thinking") avatarThink(false);
  paint();
}

function addLog(item) {
  T.log.push(item);
  if (T.log.length > MAX_LOG) T.log.splice(0, T.log.length - MAX_LOG);
  paintLog();
}

// Her words while she is still speaking: one line that keeps changing.
function liveWords(text) {
  const last = T.log.at(-1);
  if (last?.who === "her" && last.live) last.text = text;
  else T.log.push({ who: "her", text, live: true });
  paintLog();
}

function herWords(text) {
  const last = T.log.at(-1);
  if (last?.who === "her" && last.live) T.log.pop();
  addLog({ who: "her", text });
}

// ---------------------------------------------------------------- starting and stopping
function makeVoice() {
  T.voice ??= new TeacherVoice({
    getToken: ctx.speechToken,
    voice: ctx.voice(),
    ttsUrl: (text, lang) => `api/tts?${new URLSearchParams({ text, voice: ctx.voice(), lang, teacher: "1", code: ctx.accessCode() })}`,
    // cards and stars brought by a line that turned out silent still show
    events: {
      onLineStart: lineStarts,
      onLineTimed: (line) => { if (T.voice.lines[0] === line) lipsFor(line, line.ms / 1000); },
      onLineEnd: (line) => { for (const item of line.data?.after.splice(0) ?? []) show(item); },
      onIdle: voiceIdle,
    },
  });
  if (T.slow) T.voice.setSpeed(0.8);
  return T.voice;
}

async function start() {
  T.error = null;
  makeVoice().unlock();
  T.voice.warmUp();
  T.started = true;
  setStatus("connecting");
  await startListening();
  send(herTurn("start"));
}

async function startListening() {
  if (!ctx.canListen()) {
    T.micOn = false;
    T.typing = true;
    setStatus("typing");
    return;
  }
  try {
    T.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // iPhone: record and play together, and play even with the ringer switch on silent.
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch { /* older Safari */ }
    T.ears = new TeacherEars({
      onStart: heardStart,
      onUpdate: heardWords,
      onEager: heardEager,
      onResumed: heardResumed,
      onEnd: heardEnd,
      onLevel: (v) => T.el.level?.style.setProperty("--level", v.toFixed(2)),
      onError: (message) => { T.error = message; stopListening(); T.typing = true; paint(); },
      onStatus: () => {},
    }, ctx.speechToken);
    await T.ears.start(T.stream);
    T.micOn = true;
    T.muted = false;
    if (T.status === "connecting") setStatus("listening");
  } catch (err) {
    console.warn(err);
    stopListening();
    T.micOn = false;
    T.typing = true;
    T.error = err?.name === "NotAllowedError" ? "Нет доступа к микрофону — можно писать ответы" : "Микрофон не включился — можно писать ответы";
    setStatus("typing");
  }
}

function stopListening() {
  T.ears?.stop();
  T.ears = null;
  for (const track of T.stream?.getTracks() ?? []) track.stop();
  T.stream = null;
  T.micOn = false;
  clearTimeout(T.silence);
}

async function resume() {
  T.error = null;
  makeVoice().unlock();
  setStatus("connecting");
  await startListening();
  if (Date.now() - T.leftAt > 120000) send(herTurn("start", "(she came back after a break)"));
  else if (T.micOn) setStatus("listening");
}

function mainButton() {
  if (!T.started) return start();
  switch (T.status) {
    case "paused": return resume();
    case "speaking": return interrupt();
    case "hearing": return T.ears?.finishTurn();
    case "listening":
      T.ears?.mute(true);
      T.muted = true;
      return setStatus("muted");
    case "muted":
    case "typing":
      if (!T.micOn) return startListening().then(() => { if (T.micOn) { T.typing = false; setStatus("listening"); } });
      T.ears?.mute(false);
      T.muted = false;
      return setStatus("listening");
    default:
  }
}

function toggleTyping() {
  T.typing = !T.typing;
  paint();
  if (!T.el.form.hidden) T.el.input.focus();
}

function toggleSlow() {
  T.slow = !T.slow;
  ctx.save("teacherSlow", T.slow);
  T.voice?.setSpeed(T.slow ? 0.8 : 1);
  paint();
}

function pickMode(id) {
  if (T.mode === id) return;
  T.mode = id;
  ctx.save("teacherMode", id);
  if (id !== "roleplay") T.scene = null;
  paint();
  if (!T.started || T.status === "paused") return;
  const mode = TEACHER_MODES.find((m) => m.id === id);
  if (id === "roleplay") return; // a scene is picked next
  send(herTurn("mode", `${mode.label} (${id})`));
}

function pickScene(scene, label) {
  T.scene = scene;
  paint();
  if (!T.started) return start();
  send(herTurn("mode", `role-play: ${label} — ${scene}`));
}

function typed() {
  const text = T.el.input.value.trim();
  if (!text) return;
  T.el.input.value = "";
  herWords(text);
  send(herTurn("typed", text));
}

function tapped(option) {
  herWords(option);
  send(herTurn("tapped", option));
}

// ---------------------------------------------------------------- hearing her
const busyTeacher = () => T.status === "speaking" || T.status === "thinking";
// The teacher's own voice coming back from the speaker (the microphone's echo cancellation
// misses some): only while she speaks or just after, so a phrase repeated after her still counts.
const echoing = (text) => Boolean(T.voice?.recentlySpeaking(1200)) && isEcho(text, T.voice.heard());

function heardStart(text) {
  if (!T.started || T.muted || T.status === "paused") return;
  if (echoing(text)) return;
  quietAgain();
  if (T.turn?.confirmed) interrupt(); // she cut in: the teacher stops at once
  setStatus("hearing");
  liveWords(text);
  avatarListen(4000);
}

function heardWords(text) {
  if (!T.started || T.muted || T.status === "paused") return;
  if (echoing(text)) return;
  if (busyTeacher()) return heardStart(text);
  if (T.status !== "hearing") setStatus("hearing");
  liveWords(text);
  avatarListen(3000);
}

// She has probably finished: Claude starts on an answer now, and it is used if she really has.
function heardEager(text) {
  if (!T.started || T.muted || T.status === "paused" || !text) return;
  if (T.turn || echoing(text)) return;
  ask({ role: "user", content: herTurn(T.interrupted ? "interrupted" : "said", text) }, text);
}

function heardResumed() {
  if (T.turn && !T.turn.confirmed) dropTurn();
}

function heardEnd(text) {
  if (!T.started || T.muted || T.status === "paused" || !text) return;
  if (echoing(text)) {
    if (T.status === "hearing") setStatus(T.turn ? "thinking" : "listening");
    return;
  }
  herWords(text);
  const how = T.interrupted ? "interrupted" : "said";
  T.interrupted = false;
  if (T.turn && !T.turn.confirmed && T.turn.speculative === text) return confirm(T.turn);
  send(herTurn(how, text));
}

// ---------------------------------------------------------------- the teacher's turn
function context() {
  return {
    voice: ctx.voice(),
    level: ctx.level(),
    mode: T.mode,
    lesson: T.mode === "lesson" ? ctx.lessonForToday()?.id : undefined,
    review: T.mode === "review" || T.mode === "lesson" ? ctx.dueReview() : [],
    notes: T.notes,
    hour: new Date().getHours(),
    stars: T.stars,
    scene: T.mode === "roleplay" && T.scene ? T.scene : undefined,
  };
}

/** Her turn goes into the conversation and the teacher answers. */
function send(content) {
  if (T.turn?.confirmed) interrupt({ quiet: true });
  else if (T.turn) dropTurn();
  else if (T.voice?.speaking) T.voice.stop();
  T.extras.choices = null;
  quietAgain();
  T.messages.push({ role: "user", content });
  ask(null);
}

/**
 * Asks Claude for the teacher's next turn. `pending` is her turn when the question is asked
 * early (she has probably finished, not certainly): then nothing is said until `confirm`.
 */
function ask(pending, speculative = null) {
  const turn = {
    controller: new AbortController(),
    confirmed: !pending,
    pending,
    speculative,
    raw: "",
    buffer: [], // lines kept until the turn is confirmed
    lastLine: null,
    said: [], // lines of this turn already heard
    done: false,
  };
  T.turn = turn;
  if (turn.confirmed) {
    setStatus("thinking");
    avatarThink(true);
  }
  const messages = conversation(pending ? [...T.messages, pending] : T.messages);
  stream(turn, messages).catch((err) => {
    if (turn.controller.signal.aborted || T.turn !== turn) return;
    console.warn(err);
    T.turn = null;
    T.error = err.message || "Нет связи с учителем";
    if (T.messages.at(-1)?.role === "user" && turn.confirmed) addLog({ who: "note", text: `${T.error}. Скажи ещё раз или нажми «Начать».` });
    setStatus(T.micOn ? "listening" : "typing");
  });
}

async function stream(turn, messages) {
  const res = await fetch("api/teacher", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Code": ctx.accessCode() },
    body: JSON.stringify({ messages, context: context() }),
    signal: turn.controller.signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Нужен код доступа: откройте субтитры и введите его");
    if (res.status === 503) throw new Error("Учитель не подключён: на сервере нет ключа Claude");
    if (res.status === 429) throw new Error("Слишком много вопросов подряд, подожди минутку");
    throw new Error(data.error ? `Учитель недоступен (${res.status})` : "Нет связи с учителем");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const splitter = new LineSplitter();
  for (;;) {
    const { value, done } = await reader.read();
    if (T.turn !== turn) return;
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    turn.raw += text;
    for (const line of splitter.push(text)) take(turn, line);
  }
  for (const line of splitter.end()) take(turn, line);
  turn.done = true;
  if (turn.confirmed) finishTurn(turn);
}

// Her turn really was over: the answer prepared for it is used.
function confirm(turn) {
  turn.confirmed = true;
  T.messages.push(turn.pending);
  quietAgain();
  T.extras.choices = null;
  if (!turn.buffer.length && !turn.done) {
    setStatus("thinking");
    avatarThink(true);
  }
  for (const line of turn.buffer.splice(0)) act(turn, line);
  if (turn.done) finishTurn(turn);
}

function take(turn, line) {
  const item = parseLine(line);
  if (!item) return;
  if (turn.confirmed) act(turn, item);
  else turn.buffer.push(item);
}

// One of the teacher's lines: spoken, shown, or remembered.
function act(turn, item) {
  T.error = null;
  switch (item.type) {
    case "say":
      for (const part of splitForVoice(item.text)) {
        turn.lastLine = T.voice.say(part, item.lang, { turn, after: [] });
      }
      return;
    case "mood":
      avatarMood(item.mood);
      return;
    case "note":
      T.notes = rememberNote(T.notes, item.text);
      ctx.save("teacherNotes", T.notes);
      return;
    case "learned":
      if (!T.learnedNow.has(item.text)) {
        T.learnedNow.add(item.text);
        ctx.learned(item.text);
      }
      return;
    default: // card, choices, fix, star: when the line that brings them is said
      if (turn.lastLine && T.voice.lines.includes(turn.lastLine) && turn.lastLine.startAt === null) turn.lastLine.data.after.push(item);
      else show(item);
  }
}

function show(item) {
  if (item.type === "card") {
    T.extras.card = { en: item.en, ru: item.ru, say: null };
    const card = T.extras.card;
    ctx.pronounce(item.en).then((say) => { if (say && T.extras.card === card) { card.say = say; paintExtras(); } });
    T.extras.fix = null;
  } else if (item.type === "fix") {
    T.extras.fix = item;
  } else if (item.type === "choices") {
    T.extras.choices = item.options;
  } else if (item.type === "star") {
    T.stars++;
    ctx.save("teacherStars", { [ctx.dayKey()]: T.stars });
    if (ctx.countStar()) ctx.confetti();
    else if (T.stars % 5 === 0) ctx.confetti();
    T.el.stars?.classList.remove("pop");
    void T.el.stars?.offsetWidth;
    T.el.stars?.classList.add("pop");
  }
  paint();
}

function lineStarts(line, clock) {
  const turn = line.data?.turn;
  if (T.turn !== turn) return;
  avatarThink(false);
  setStatus("speaking");
  line.clock = clock;
  lipsFor(line, line.ms ? line.ms / 1000 : line.text.length * (line.lang === "ru" ? 0.068 : 0.062));
  if (!turn.said.length) { // a new turn: last turn's card and correction make way
    T.extras.card = null;
    T.extras.fix = null;
    paintExtras();
  }
  addLog({ who: "teacher", text: line.text, lang: line.lang });
  turn.said.push(line);
  for (const item of line.data.after.splice(0)) show(item);
}

// The face's lips for a line: its words spread over its audio (`seconds`, estimated until known).
function lipsFor(line, seconds) {
  if (line.clock) avatarSay(line.text, line.clock, spreadWords(line.text, [0.03, Math.max(0.4, seconds - 0.1)]));
}

function voiceIdle() {
  const turn = T.turn;
  if (turn?.done && turn.confirmed) finishTurn(turn);
}

// The teacher has said everything: her answer goes into the conversation, and it's her turn.
function finishTurn(turn) {
  if (T.turn !== turn || T.voice.speaking) return;
  T.turn = null;
  avatarHush();
  // (no answer at all: her turn stays and goes with the next one)
  if (turn.raw.trim()) T.messages.push({ role: "assistant", content: turn.raw.trim() });
  setStatus(T.muted ? "muted" : T.micOn ? "listening" : "typing");
  waitForHer();
}

/** Stops the teacher mid-turn (she cut in, or tapped "Перебить"). */
function interrupt({ quiet = false } = {}) {
  const turn = T.turn;
  const heard = T.voice?.stop() ?? [];
  avatarHush();
  avatarThink(false);
  if (!turn) return;
  T.turn = null;
  turn.controller.abort();
  if (!turn.confirmed) return;
  // What she heard is what the teacher said; the rest never happened.
  const said = heard.length ? heard.map((t) => `${/[Ѐ-ӿ]/.test(t) ? "ru" : "en"}: ${t}`).join("\n") : "";
  if (said) {
    T.messages.push({ role: "assistant", content: `${said}\n(she cut in here)` });
    if (!quiet) T.interrupted = true;
  }
  if (!quiet) setStatus(T.micOn && !T.muted ? "listening" : "typing");
}

// An answer prepared early that she didn't need after all (she went on talking).
function dropTurn() {
  const turn = T.turn;
  if (!turn) return;
  T.turn = null;
  turn.controller.abort();
  if (turn.confirmed) {
    T.voice?.stop();
    avatarHush();
  }
}

// ---------------------------------------------------------------- silence
function waitForHer() {
  clearTimeout(T.silence);
  if (!T.micOn || T.muted || T.askedSilence) return;
  T.silence = setTimeout(() => {
    if (T.status !== "listening" || document.hidden || !T.el.status?.isConnected) return;
    T.askedSilence = true;
    send(herTurn("silence"));
  }, SILENCE_MS);
}

function quietAgain() {
  clearTimeout(T.silence);
  T.askedSilence = false;
}
