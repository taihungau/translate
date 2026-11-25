// The AI teacher's voice. Each spoken line goes to Deepgram Flux TTS over a WebSocket (one per
// language: an American voice for English, a Russian voice for Russian) and is played through
// Web Audio as soon as its first audio arrives, so she starts talking a fraction of a second after
// a line is written. Lines play in order, without gaps, whichever socket they came from.
// If a socket can't be used, the line is fetched whole from /api/tts instead; if even that fails,
// the phone's own voice reads it.

const SAMPLE_RATE = 24000;
const GAP = 0.12; // seconds between two lines, like a breath
const STALL = 4; // seconds a line may wait for its first audio before it is fetched whole instead
// The same voices as the server's TEACHER_VOICES (lib/handler.js).
export const FLUX_VOICES = {
  female: { en: "flux-hannah-en", ru: "flux-natalia-ru" },
  male: { en: "flux-cole-en", ru: "flux-mikhail-ru" },
};
export const fluxSpeakUrl = (model) => `wss://api.deepgram.com/v2/speak?${new URLSearchParams({ model, encoding: "linear16", sample_rate: String(SAMPLE_RATE) })}`;

let lineIds = 0;

/** One Deepgram socket for one voice. Lines are spoken in the order they were sent. */
class FluxSocket {
  constructor(model, getToken, events) {
    this.model = model;
    this.getToken = getToken;
    this.events = events; // { audio(line, samples), ended(line, ms), failed(lines) }
    this.ws = null;
    this.opening = null;
    this.waiting = []; // lines sent, their audio not started yet
    this.current = null; // the line whose audio is arriving
    this.carry = null; // half a sample left over from the last frame
    this.broken = false; // couldn't connect: lines go another way for the rest of the session
    this.speed = 1;
  }

  open() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.opening ??= (async () => {
      const token = await this.getToken();
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(fluxSpeakUrl(this.model), ["bearer", token]);
        ws.binaryType = "arraybuffer";
        let opened = false;
        ws.onopen = () => {
          opened = true;
          this.ws = ws;
          if (this.speed !== 1) ws.send(JSON.stringify({ type: "Configure", speed: this.speed }));
          resolve();
        };
        ws.onmessage = ({ data }) => this.onMessage(data);
        ws.onclose = () => {
          if (!opened) return reject(new Error("Voice connection refused"));
          if (this.ws === ws) this.dropped();
        };
      });
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  async speak(line) {
    try {
      await this.open();
    } catch {
      this.broken = true;
      this.events.failed([line]);
      return;
    }
    this.waiting.push(line);
    this.ws.send(JSON.stringify({ type: "Speak", text: line.text }));
    this.ws.send(JSON.stringify({ type: "Flush" })); // one line, one turn: its audio comes as soon as possible
  }

  onMessage(data) {
    if (typeof data !== "string") {
      if (this.current) this.events.audio(this.current, this.samples(data));
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "SpeechStarted") {
      this.current = this.waiting.shift() ?? null;
      this.carry = null;
    } else if (msg.type === "SpeechMetadata") {
      if (this.current) this.events.ended(this.current, msg.audio_duration_ms);
      this.current = null;
    } else if (msg.type === "Error") {
      console.warn("Deepgram voice:", msg.code, msg.description);
    }
  }

  /** 16-bit little-endian PCM → floats, keeping a split sample for the next frame. */
  samples(buffer) {
    let bytes = new Uint8Array(buffer);
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      bytes = joined;
      this.carry = null;
    }
    if (bytes.length % 2) {
      this.carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }

  // The connection dropped mid-sentence: the lines still owed are spoken another way.
  dropped() {
    this.ws = null;
    const owed = [...(this.current ? [this.current] : []), ...this.waiting];
    this.current = null;
    this.waiting = [];
    if (owed.length) this.events.failed(owed);
  }

  setSpeed(speed) {
    this.speed = speed;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Configure", speed }));
  }

  /** Nothing waiting: a harmless message keeps the connection from closing after a minute of quiet. */
  keepAlive() {
    if (this.ws?.readyState === WebSocket.OPEN && !this.current && !this.waiting.length) this.ws.send(JSON.stringify({ type: "Flush" }));
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.current = null;
    this.waiting = [];
    try { ws?.close(); } catch { /* already closed */ }
  }
}

/**
 * The voice: `say(text, lang)` queues a line; lines are spoken in order. Events:
 * onLineStart(line, clock) when a line begins to be heard (`clock` is a media-like object whose
 * currentTime follows the audio, for the face's lips), onLineEnd(line), onIdle() when everything
 * queued has been said.
 */
export class TeacherVoice {
  constructor({ getToken, voice = "female", ttsUrl, events = {} }) {
    this.getToken = getToken;
    this.ttsUrl = ttsUrl; // (text, lang) → URL of the whole line as MP3
    this.events = events;
    this.ctx = null;
    this.lines = []; // queued and playing, in order
    this.cursor = 0; // where the next audio starts, in AudioContext time
    this.timers = new Set();
    this.recent = []; // { text, until } lines heard lately, for the echo check
    this.lastEnd = 0; // when the last line finished (performance.now())
    this.speed = 1;
    this.setVoice(voice);
    this.keepAlive = setInterval(() => { for (const s of Object.values(this.sockets)) s.keepAlive(); }, 25000);
  }

  setVoice(voice) {
    if (this.voice === voice) return;
    this.voice = FLUX_VOICES[voice] ? voice : "female";
    for (const s of Object.values(this.sockets ?? {})) s.close();
    const events = {
      audio: (line, samples) => this.audio(line, samples),
      ended: (line, ms) => this.ended(line, ms),
      failed: (lines) => { for (const line of lines) this.whole(line); },
    };
    this.sockets = Object.fromEntries(Object.entries(FLUX_VOICES[this.voice]).map(([lang, model]) => [lang, new FluxSocket(model, this.getToken, events)]));
  }

  /** Call from a tap: browsers only let a page start sound after the person touches it. */
  unlock() {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;
    ctx.resume().catch(() => {});
    const blip = ctx.createBufferSource();
    blip.buffer = ctx.createBuffer(1, 1, SAMPLE_RATE);
    blip.connect(ctx.destination);
    blip.start();
    return ctx;
  }

  /** Opens the sockets ahead of time, so the first line isn't slowed by connecting. */
  warmUp() {
    for (const s of Object.values(this.sockets)) if (!s.broken) s.open().catch(() => { s.broken = true; });
  }

  get speaking() {
    return this.lines.length > 0;
  }

  say(text, lang = "en", data = null) {
    const line = { id: ++lineIds, text, lang: lang === "ru" ? "ru" : "en", data, chunks: [], scheduled: 0, received: false, ms: null, startAt: null, endAt: null, sources: [] };
    this.lines.push(line);
    const socket = this.sockets[line.lang];
    if (!socket || socket.broken || !window.WebSocket) this.whole(line);
    else socket.speak(line);
    return line;
  }

  setSpeed(speed) {
    this.speed = speed;
    for (const s of Object.values(this.sockets)) s.setSpeed(speed);
  }

  // ---- audio arriving
  audio(line, samples) {
    if (!this.lines.includes(line) || line.whole || !samples.length) return;
    line.chunks.push(samples);
    this.pump();
  }

  ended(line, ms) {
    if (line.whole) return;
    line.received = true;
    line.ms = ms;
    if (line.startAt !== null && ms) this.events.onLineTimed?.(line); // already playing: now its length is known
    this.pump();
  }

  // The whole line at once, from the app's server (MP3), or the phone's own voice.
  async whole(line) {
    if (!this.lines.includes(line) || line.whole) return;
    line.whole = true;
    line.chunks = [];
    try {
      const res = await fetch(this.ttsUrl(line.text, line.lang));
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const buffer = await (this.ctx ?? this.unlock()).decodeAudioData(await res.arrayBuffer());
      if (!this.lines.includes(line)) return;
      line.chunks = [buffer];
      line.received = true;
      line.ms = buffer.duration * 1000;
    } catch {
      line.device = true;
      line.received = true;
    }
    this.pump();
  }

  // ---- playing, in order
  pump() {
    const line = this.lines[0];
    if (!line || !this.ctx) return;
    // Its turn to be heard and no audio yet: if none comes soon, it is fetched another way.
    if (!line.watched && line.startAt === null) {
      line.watched = true;
      this.later(this.ctx.currentTime + STALL, () => {
        if (this.lines[0] === line && line.startAt === null && !line.chunks.length) this.whole(line);
      });
    }
    if (line.device) {
      if (line.startAt === null) this.speakWithDevice(line);
      return;
    }
    const ctx = this.ctx;
    while (line.scheduled < line.chunks.length) {
      const chunk = line.chunks[line.scheduled++];
      let buffer = chunk;
      if (!(chunk instanceof AudioBuffer)) {
        buffer = ctx.createBuffer(1, chunk.length, SAMPLE_RATE);
        buffer.copyToChannel(chunk, 0);
      }
      const at = Math.max(this.cursor, ctx.currentTime + 0.04);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(at);
      line.sources.push(src);
      this.cursor = at + buffer.duration;
      if (line.startAt === null) {
        line.startAt = at;
        this.later(at, () => this.events.onLineStart?.(line, this.clock(line)));
      }
    }
    if (line.received && line.scheduled === line.chunks.length && line.endAt === null) {
      if (line.startAt === null) return this.finish(line); // nothing to say after all
      line.endAt = this.cursor;
      this.cursor += GAP;
      this.later(line.endAt, () => this.finish(line));
    }
  }

  finish(line) {
    if (this.lines[0] !== line) return;
    this.lines.shift();
    this.lastEnd = performance.now();
    this.recent.push({ text: line.text, until: performance.now() + 8000 });
    this.events.onLineEnd?.(line);
    if (this.lines.length) this.pump();
    else this.events.onIdle?.();
  }

  // A clock the face can read like an <audio> element's.
  clock(line) {
    const ctx = this.ctx;
    const voice = this;
    return {
      currentSrc: `voice:${line.id}`,
      src: `voice:${line.id}`,
      error: null,
      playbackRate: 1,
      get currentTime() { return Math.max(0, ctx.currentTime - line.startAt); },
      get paused() { return false; },
      get ended() { return !voice.lines.includes(line); },
      get duration() { return line.ms ? line.ms / 1000 : NaN; },
    };
  }

  speakWithDevice(line) {
    const synth = window.speechSynthesis;
    line.startAt = this.ctx.currentTime;
    if (!synth) return this.later(this.ctx.currentTime + 0.5, () => this.finish(line));
    const u = new SpeechSynthesisUtterance(line.text);
    u.lang = line.lang === "ru" ? "ru-RU" : "en-US";
    u.rate = this.speed;
    const voice = synth.getVoices().find((v) => v.lang.replace("_", "-").startsWith(u.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    line.ms = (line.text.length * 70) / this.speed;
    u.onend = u.onerror = () => this.finish(line);
    this.events.onLineStart?.(line, this.clock(line));
    synth.speak(u);
  }

  later(at, fn) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, Math.max(0, (at - this.ctx.currentTime) * 1000));
    this.timers.add(timer);
  }

  /** Speaking now, or stopped less than `ms` ago: when the microphone may still pick her up. */
  recentlySpeaking(ms = 1200) {
    return this.lines.some((l) => l.startAt !== null) || performance.now() - this.lastEnd < ms;
  }

  /** Text heard in the last few seconds, and the line being said: what an echo would repeat. */
  heard() {
    const now = performance.now();
    this.recent = this.recent.filter((r) => r.until > now);
    return [...this.recent.map((r) => r.text), ...this.lines.filter((l) => l.startAt !== null).map((l) => l.text)].join(" ");
  }

  /**
   * She cut in: silence at once, forget what was queued. Returns what she actually heard of this
   * turn (whole lines, and the share of the line in progress).
   */
  stop() {
    const ctx = this.ctx;
    const heard = [];
    for (const line of this.lines) {
      if (line.startAt === null || !ctx) continue;
      const played = ctx.currentTime - line.startAt;
      const length = (line.endAt ?? this.cursor) - line.startAt;
      if (played <= 0) continue;
      if (played >= length) heard.push(line.text);
      else {
        const words = line.text.split(/\s+/);
        heard.push(`${words.slice(0, Math.max(1, Math.round((words.length * played) / length))).join(" ")}…`);
      }
      this.recent.push({ text: line.text, until: performance.now() + 8000 });
    }
    for (const line of this.lines) for (const src of line.sources) { try { src.stop(); } catch { /* not started */ } }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    window.speechSynthesis?.cancel();
    const hadLines = this.lines.length > 0;
    if (this.lines.some((l) => l.startAt !== null)) this.lastEnd = performance.now();
    this.lines = [];
    this.cursor = 0;
    // Audio already on its way would belong to cancelled lines: fresh connections instead.
    if (hadLines) for (const s of Object.values(this.sockets)) { if (s.current || s.waiting.length) s.close(); }
    return heard;
  }

  close() {
    this.stop();
    clearInterval(this.keepAlive);
    for (const s of Object.values(this.sockets)) s.close();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
