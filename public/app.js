import { parseSubtitles, toSrt, findCueAt } from "./subtitles.js";

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

// ---------------------------------------------------------------- translation engines
// "chrome": Chrome's on-device Translator API (Chrome 138+ desktop). Free, no key, no server.
// "claude": POST /api/translate, which calls Claude with the server's ANTHROPIC_API_KEY.
const engineSel = $("engine");
const engineStatus = $("engineStatus");
const hasBuiltIn = "Translator" in self;
const PAIR = { sourceLanguage: "en", targetLanguage: "ru" };

function setEngineStatus(text, isError = false) {
  engineStatus.textContent = text;
  engineStatus.classList.toggle("error", isError);
}

if (!hasBuiltIn) {
  engineSel.querySelector('[value="chrome"]').disabled = true;
  engineSel.value = "claude";
  setEngineStatus("This browser has no built-in translator; use desktop Chrome 138+ for free translation.");
} else {
  try { engineSel.value = localStorage.getItem("engine") || "chrome"; } catch { /* storage blocked */ }
  if (engineSel.value === "chrome") setEngineStatus("Free, runs on this computer");
}

async function createBuiltIn() {
  const availability = await Translator.availability(PAIR);
  if (availability === "unavailable") {
    throw new Error("Chrome can't translate English to Russian on this device. Switch to Claude.");
  }
  const translator = await Translator.create({
    ...PAIR,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) =>
        setEngineStatus(`Downloading Russian language pack… ${Math.round(e.loaded * 100)}%`));
    },
  });
  setEngineStatus("Free, runs on this computer");
  return translator;
}

let builtIn = null;
function getBuiltIn() {
  builtIn ??= (async () => {
    setEngineStatus("Preparing Chrome's translator…");
    const slow = setTimeout(() => setEngineStatus(
      "Chrome's translator is still getting ready. If this doesn't finish, switch to Claude.", true), 20000);
    try {
      return await createBuiltIn();
    } finally {
      clearTimeout(slow);
    }
  })().catch((err) => {
    builtIn = null;
    // The first download must start from a click; Start / choosing a file count as one.
    const msg = err?.name === "NotAllowedError"
      ? "Press Start (or choose the subtitle file again) to download Chrome's Russian language pack."
      : err.message;
    setEngineStatus(msg, true);
    throw new Error(msg);
  });
  return builtIn;
}

/** Call from a click handler so Chrome may download its language pack. */
export function prepareEngine() {
  if (engineSel.value === "chrome") getBuiltIn().catch(() => {});
}

engineSel.addEventListener("change", () => {
  try { localStorage.setItem("engine", engineSel.value); } catch { /* storage blocked */ }
  if (engineSel.value === "chrome") { setEngineStatus("Free, runs on this computer"); prepareEngine(); }
  else setEngineStatus("Uses the server's Anthropic API key");
});

async function translate(lines, context = []) {
  if (engineSel.value === "chrome") {
    const translator = await getBuiltIn();
    return Promise.all(lines.map(async (l) => ({ id: l.id, text: l.text.trim() ? await translator.translate(l.text) : "" })));
  }
  return translateWithClaude(lines, context);
}

async function translateWithClaude(lines, context = [], retried = false) {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Code": storedCode() },
    body: JSON.stringify({ lines, context }),
  });
  if (res.status === 401 && !retried && (await askForCode())) return translateWithClaude(lines, context, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.translations;
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

// ---------------------------------------------------------------- tabs
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", String(t === tab));
    }
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === tab.dataset.panel);
  });
}

// ---------------------------------------------------------------- live mode
(() => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const toggleBtn = $("liveToggle");
  const statusEl = $("liveStatus");
  const enEl = $("liveEn");
  const ruEl = $("liveRu");
  const stage = $("liveStage");

  let recognition = null;
  let listening = false;
  let fadeTimer = null;
  const recentEnglish = [];

  // Each spoken phrase gets a number. While it is still being spoken we translate the
  // partial text (rank 0, 1, 2...) so Russian appears immediately; the final text gets
  // rank Infinity. Translations finish out of order, so only show something newer.
  let phrase = 0;
  let interimRank = 0;
  let shown = { phrase: -1, rank: -1 };

  const MIN_INTERIM_WORDS = 3;
  const MAX_SUBTITLE_CHARS = 110;

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
  }

  if (!Recognition) {
    toggleBtn.disabled = true;
    setStatus("Speech recognition is not available in this browser. Try Chrome or Edge, or use the video mode.", true);
  }

  function showEnglish(finalText, interimText = "") {
    enEl.classList.remove("faded");
    enEl.textContent = tail(finalText);
    if (interimText) {
      const span = document.createElement("span");
      span.className = "interim";
      span.textContent = (finalText ? " " : "") + tail(interimText);
      enEl.append(span);
    }
  }

  // Long run-on speech would fill the screen; keep the end, which is what is being said now.
  function tail(text) {
    if (text.length <= MAX_SUBTITLE_CHARS) return text;
    const cut = text.slice(-MAX_SUBTITLE_CHARS);
    return "…" + cut.slice(cut.indexOf(" ") + 1);
  }

  function show(p, rank, ru, en) {
    if (!ru || p < shown.phrase || (p === shown.phrase && rank <= shown.rank)) return;
    shown = { phrase: p, rank };
    ruEl.textContent = tail(ru);
    ruEl.classList.remove("faded");
    if (rank === Infinity) showEnglish(en);
    // Clear the line once it has been on screen long enough, like a real subtitle.
    clearTimeout(fadeTimer);
    const hold = Math.min(8000, Math.max(3000, ru.length * 80));
    fadeTimer = setTimeout(() => {
      ruEl.classList.add("faded");
      enEl.classList.add("faded");
    }, hold);
  }

  // Partial text: translate the latest version, never queue up stale ones.
  let interimBusy = false;
  let interimNext = null;
  async function translateInterim(text) {
    interimNext = { p: phrase, rank: interimRank++, text };
    if (interimBusy) return;
    interimBusy = true;
    while (interimNext) {
      const job = interimNext;
      interimNext = null;
      try {
        const [result] = await translate([{ id: "interim", text: job.text }], recentEnglish.slice(-6));
        if (job.p === phrase) show(job.p, job.rank, result?.text, job.text);
      } catch { /* the final translation will report errors */ }
    }
    interimBusy = false;
  }

  async function addPhrase(text) {
    const p = phrase++;
    interimNext = null;
    const context = recentEnglish.slice(-6);
    recentEnglish.push(text);
    if (recentEnglish.length > 20) recentEnglish.shift();

    try {
      const [result] = await translate([{ id: String(p), text }], context);
      show(p, Infinity, result?.text, text);
      if (listening) setStatus("Listening…");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function start() {
    prepareEngine();
    recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.trim();
        if (!transcript) continue;
        if (result.isFinal) addPhrase(transcript);
        else interim += transcript + " ";
      }
      interim = interim.trim();
      if (!interim) return;
      showEnglish("", interim);
      // Partial translations are near-instant with Chrome's on-device translator. With Claude
      // each one would be a paid request, so Claude only translates finished phrases.
      if (engineSel.value === "chrome" && interim.split(/\s+/).length >= MIN_INTERIM_WORDS) {
        translateInterim(interim);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setStatus("Microphone access was denied.", true);
        stop();
      } else setStatus(`Speech recognition: ${event.error}`, true);
    };
    // Browsers end recognition after a pause or ~60 s; restart while the user wants to listen.
    recognition.onend = () => {
      if (listening) {
        try { recognition.start(); } catch { /* already started */ }
      }
    };

    listening = true;
    recognition.start();
    toggleBtn.textContent = "Stop";
    toggleBtn.classList.add("listening");
    document.body.classList.add("listening");
    setStatus("Listening…");
  }

  function stop() {
    listening = false;
    recognition?.stop();
    toggleBtn.textContent = "Start";
    toggleBtn.classList.remove("listening");
    document.body.classList.remove("listening");
    if (!statusEl.classList.contains("error")) setStatus("Stopped");
  }

  toggleBtn.addEventListener("click", () => (listening ? stop() : start()));
  $("liveShowEn").addEventListener("change", (e) => stage.classList.toggle("hide-en", !e.target.checked));
  $("liveFullscreen").addEventListener("click", () => toggleFullscreen(stage));
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
    const done = cues.filter((c) => c.ru !== undefined).length;
    progressEl.max = cues.length || 1;
    progressEl.value = done;
    const failed = cues.filter((c) => c.ru === undefined && c.attempts >= MAX_ATTEMPTS).length;
    if (!cues.length) setStatus("No subtitles loaded");
    else if (done === cues.length) setStatus(`All ${cues.length} subtitles translated`);
    else if (failed && !inFlight) setStatus(`${done}/${cues.length} translated, ${failed} failed: ${lastError}`, true);
    else setStatus(`Translating… ${done}/${cues.length}`);
    downloadBtn.disabled = done === 0;
    downloadBtn.textContent = done === cues.length ? "Download Russian .srt" : "Download partial .srt";
  }

  const needsWork = (c) => c.ru === undefined && !c.pending && c.attempts < MAX_ATTEMPTS && Date.now() >= c.retryAt;

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
    const size = cues.some((c) => c.ru !== undefined) ? BATCH : FIRST_BATCH;
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
    if (!inFlight && cues.some((c) => c.ru === undefined && c.attempts < MAX_ATTEMPTS)) setTimeout(pump, 1000);
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
        if (byId.has(c.id)) c.ru = byId.get(c.id);
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
    const key = `${idx}|${mode}|${cue?.ru !== undefined}`;
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
        };
        if (mode !== "en") {
          if (cue.ru !== undefined) addLine(cue.ru, "ru");
          else if (cue.attempts >= MAX_ATTEMPTS) addLine(cue.text, "ru");
          else addLine("перевод…", "wait");
        }
        if (mode !== "ru") addLine(cue.text, "en");
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
    generation++;
    inFlight = 0;
    renderedKey = "";
    fileName = file.name.replace(/\.(srt|vtt)$/i, "").replace(/[._-](en|eng|english)$/i, "");
    cues = parsed.map((c) => ({ ...c, ru: undefined, pending: false, attempts: 0, retryAt: 0 }));
    if (!cues.length) {
      setStatus("No subtitles found in that file", true);
      return;
    }
    updateProgress();
    pump();
  });

  // Seeking changes which cues are most urgent; pump() reads currentTime each time.
  video.addEventListener("seeked", pump);
  modeSel.addEventListener("change", () => (renderedKey = ""));
  $("playerFullscreen").addEventListener("click", () => toggleFullscreen($("player")));

  downloadBtn.addEventListener("click", () => {
    const srt = toSrt(cues, (c) => c.ru ?? c.text);
    const url = URL.createObjectURL(new Blob([srt], { type: "application/x-subrip;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${fileName}.ru.srt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
