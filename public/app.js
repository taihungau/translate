import { parseSubtitles, toSrt, findCueAt } from "./subtitles.js";
import { LocalRecognizer } from "./local-asr.js";

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
function opusTranslate(texts) {
  if (!mtWorker) {
    mtWorker = new Worker(new URL("./mt-worker.js", import.meta.url), { type: "module" });
    mtWorker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        const pct = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
        setEngineStatus(`Downloading translation model… ${pct}% (only the first time)`);
        return;
      }
      const job = mtPending.get(data.id);
      if (!job) return;
      mtPending.delete(data.id);
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
    mtWorker.postMessage({ type: "translate", id, texts });
  });
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
  else if (engineSel.value === "opus") setEngineStatus("Free; downloads ~80 MB the first time");
  else setEngineStatus("Uses the server's Anthropic API key");
});

async function translate(lines, context = []) {
  if (engineSel.value === "opus") {
    const texts = lines.map((l) => l.text.trim());
    const nonEmpty = texts.filter(Boolean);
    const out = nonEmpty.length ? await opusTranslate(nonEmpty) : [];
    let k = 0;
    return lines.map((l, i) => ({ id: l.id, text: texts[i] ? out[k++] ?? "" : "" }));
  }
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

  function handleInterim(interim) {
    showEnglish("", interim);
    // Partial translations are free with the on-device translators. With Claude each one
    // would be a paid request, so Claude only translates finished phrases.
    if (engineSel.value !== "claude" && interim.split(/\s+/).length >= MIN_INTERIM_WORDS) {
      translateInterim(interim);
    }
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

  const asrSel = $("liveAsr");
  const langSel = $("liveLang");
  const local = new LocalRecognizer({
    onInterim: (text) => handleInterim(text),
    onFinal: (text) => addPhrase(text),
    onStatus: (text) => setStatus(text),
    onError: (message) => setStatus(message, true),
  });
  const micSel = $("liveMic");
  const levelEl = $("liveLevel");
  let micStream = null;
  let micTrack = null;
  let stopMeter = null;

  try {
    langSel.value = localStorage.getItem("liveLang") || "en-US";
    asrSel.value = localStorage.getItem("liveAsr") || "chrome";
    if (!asrSel.value) asrSel.value = "chrome";
  } catch { /* storage blocked */ }
  const usesChrome = () => asrSel.value === "chrome";
  langSel.hidden = !usesChrome(); // on-device models are English-only and handle accents themselves
  if (!Recognition) {
    // No browser speech recognition: on-device models still work.
    asrSel.querySelector('[value="chrome"]').disabled = true;
    if (usesChrome()) asrSel.value = "whisper-base";
    toggleBtn.disabled = false;
    setStatus("");
  }

  async function listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    let saved = micSel.value;
    try { saved ||= localStorage.getItem("liveMic") || ""; } catch { /* storage blocked */ }
    micSel.replaceChildren(new Option("Default microphone", ""));
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
  try { boostSel.value = localStorage.getItem("liveBoost") || "3"; } catch { /* storage blocked */ }
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
    const out = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(stream).connect(gain).connect(comp).connect(out);
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

  function runRecognition() {
    recognition.lang = langSel.value;
    try {
      // Chrome can recognise speech from our raw microphone track; browsers that can't
      // ignore the argument and use the default microphone with their usual processing.
      recognition.start(micTrack ?? undefined);
    } catch (err) {
      if (err?.name === "InvalidStateError") return; // already running
      recognition.start();
    }
  }

  async function start() {
    prepareEngine();
    listening = true;
    toggleBtn.textContent = "Stop";
    toggleBtn.classList.add("listening");
    document.body.classList.add("listening");
    setStatus("Starting microphone…");
    try {
      await openMic();
    } catch (err) {
      // Fall back to letting speech recognition open the microphone itself.
      console.warn("getUserMedia failed, using default recognition input", err);
      if (err?.name === "NotAllowedError") {
        setStatus("Microphone access was denied.", true);
        stop();
        return;
      }
    }
    if (!listening) return closeMic();

    if (!usesChrome()) {
      if (!micStream) {
        setStatus("Couldn't open the microphone.", true);
        stop();
        return;
      }
      try {
        const device = await local.load(asrSel.value);
        if (!listening) return;
        await local.start(micStream);
        setStatus(device === "webgpu" ? "Listening (on device, GPU)…" : "Listening (on device, CPU: may lag)…");
      } catch (err) {
        setStatus(err.message, true);
        stop();
      }
      return;
    }

    recognition = new Recognition();
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
      if (interim) handleInterim(interim);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setStatus("Microphone access was denied.", true);
        stop();
      } else setStatus(`Speech recognition: ${event.error}`, true);
    };
    // Browsers end recognition after a pause or ~60 s; restart while the user wants to listen.
    // Restarting also applies a changed accent.
    recognition.onend = () => {
      if (listening) runRecognition();
    };

    runRecognition();
    setStatus("Listening…");
  }

  function stop() {
    listening = false;
    recognition?.stop();
    recognition = null;
    local.stop();
    closeMic();
    toggleBtn.textContent = "Start";
    toggleBtn.classList.remove("listening");
    document.body.classList.remove("listening");
    if (!statusEl.classList.contains("error")) setStatus("Stopped");
  }

  langSel.addEventListener("change", () => {
    try { localStorage.setItem("liveLang", langSel.value); } catch { /* storage blocked */ }
    recognition?.stop(); // onend restarts it with the new accent
  });
  asrSel.addEventListener("change", async () => {
    try { localStorage.setItem("liveAsr", asrSel.value); } catch { /* storage blocked */ }
    langSel.hidden = !usesChrome();
    if (!listening) return;
    stop();
    await start();
  });
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
