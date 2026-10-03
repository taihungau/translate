// Speech recognition with Whisper Large v3 Turbo running in the browser (WebGPU) through
// transformers.js. Microphone audio is captured at 16 kHz and cut into stretches of 2-12 s at
// natural pauses: Whisper is most accurate with several seconds of context. While a stretch is
// still being spoken, Whisper re-reads it whenever it is free, so the text updates live.
// No audio is thrown away: in a cinema, dialogue sits on top of music and effects, so a
// loudness gate would miss words. Loudness is only used to choose where to cut.

export const MODEL = {
  repo: "onnx-community/whisper-large-v3-turbo",
  // The settings of the official transformers.js WebGPU demo for this model: half-precision
  // encoder (accuracy) and 4-bit decoder (speed). About 1.3 GB, downloaded once.
  dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
};

const SAMPLE_RATE = 16000;
const FRAME = 480; // 30 ms
const FRAME_MS = 30;
const PAUSE_MS = 350; // a dip this long counts as a pause between sentences
const MIN_CHUNK_MS = 2000; // Whisper needs a few seconds of context to be accurate
const MAX_CHUNK_MS = 12000; // long run-on speech is cut at its quietest point before this
const MAX_FINAL_MS = 25000; // Whisper's window is 30 s
const FIRST_LIVE_MS = 1000; // start showing live text after this much of a stretch
const SILENT_RMS = 0.002; // below this nothing is audible at all

// Whisper invents text for music, applause and silence.
const JUNK = /^(thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+|-+|so\.?)$/i;

export function cleanTranscript(text) {
  const cleaned = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ") // [Music], (laughs), *sighs*, ♪
    .replace(/\s+/g, " ")
    // Over music the model sometimes loops: "go go go go", "I'm here. I'm here. I'm here."
    .replace(/(\b.{2,40}?)(?:[\s,.!?]+\1\b){2,}/gi, "$1")
    .trim();
  return JUNK.test(cleaned) ? "" : cleaned;
}

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("capture", Capture);
`;

export class LocalRecognizer {
  /**
   * @param {{onInterim(text: string): void, onFinal(text: string, opts: {show: boolean}): void,
   *          onError(message: string): void,
   *          onProgress(p: {pct: number | null, text: string}): void,
   *          onTiming?(ms: number): void}} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    this.worker = null;
    this.ready = null;
    this.busy = 0;
    this.nextId = 0;
    this.ctx = null;
    this.chunkSeq = 0; // number of the stretch currently being recorded
    this.liveChunk = -1; // newest stretch whose text is on screen
    this.partials = new Map(); // stretch -> latest live text
    this.finals = new Map(); // stretch -> final text
    this.cutTimes = new Map(); // stretch -> when it ended
    this.pendingFinal = []; // finished audio waiting for Whisper to be free
    this.pendingChunk = -1;
  }

  /** Download (first time only) and load the model. Resolves with "webgpu". */
  load() {
    if (this.ready) return this.ready;
    this.worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.type === "progress") {
          const pct = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
          this.h.onProgress({
            pct,
            text: data.saved
              ? `Loading the speech model… ${pct}%`
              : `Downloading the speech model (one time only)… ${pct}% · ${Math.round(data.loaded / 1e6)} of ${Math.round(data.total / 1e6)} MB`,
          });
        } else if (data.type === "phase") {
          this.h.onProgress({ pct: null, text: "Preparing the speech model on the GPU…" });
        } else if (data.type === "ready") {
          resolve(data.device);
        } else if (data.type === "error" && data.id === undefined) {
          reject(new Error(data.message));
        } else {
          this.onMessage(data);
        }
      };
    });
    this.ready.catch(() => {
      this.worker?.terminate();
      this.worker = null;
      this.ready = null; // allow another try
    });
    this.worker.postMessage({ type: "load", ...MODEL });
    return this.ready;
  }

  // The caption on screen is the previous sentence followed by the live words of the current
  // one, like rolling TV captions.
  onMessage(data) {
    if (data.type === "error") {
      this.busy--;
      this.h.onError(data.message);
      queueMicrotask(() => this.flushFinal());
      return;
    }
    if (data.type !== "result") return;
    this.busy--;
    this.h.onTiming?.(data.ms);
    queueMicrotask(() => this.flushFinal()); // Whisper is free again

    const text = cleanTranscript(data.text);
    const c = data.chunk;
    if (data.final) {
      this.finals.set(c, text);
      if (!text) return;
      if (c >= this.liveChunk) {
        this.liveChunk = c;
        this.h.onFinal(text, { show: true });
      } else {
        this.h.onFinal(text, { show: false });
        if (c === this.liveChunk - 1) this.emitCaption();
      }
    } else {
      if (c < this.liveChunk || this.finals.has(c) || !text) return;
      this.liveChunk = c;
      this.partials.set(c, text);
      this.emitCaption();
    }
    for (const k of this.partials.keys()) if (k < this.liveChunk - 2) this.partials.delete(k);
    for (const k of this.finals.keys()) if (k < this.liveChunk - 2) this.finals.delete(k);
  }

  emitCaption() {
    const c = this.liveChunk;
    const live = this.finals.get(c) || this.partials.get(c) || "";
    // Keep the previous sentence only if it ended a moment ago, not after a long silence.
    const prevEnded = this.cutTimes.get(c - 1) ?? 0;
    const prev = performance.now() - prevEnded < 3500 ? this.finals.get(c - 1) || this.partials.get(c - 1) || "" : "";
    const caption = [prev, live].filter(Boolean).join(" ");
    if (caption) this.h.onInterim(caption);
  }

  async start(stream) {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, "capture");
    this.ctx.createMediaStreamSource(stream).connect(node);
    this.carry = new Float32Array(0);
    this.chunk = [];
    this.levels = [];
    this.quietRun = 0;
    this.pendingFinal = [];
    node.port.onmessage = ({ data }) => this.feed(data);
  }

  stop() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  feed(samples) {
    const buf = new Float32Array(this.carry.length + samples.length);
    buf.set(this.carry);
    buf.set(samples, this.carry.length);
    let i = 0;
    for (; i + FRAME <= buf.length; i += FRAME) this.frame(buf.slice(i, i + FRAME));
    this.carry = buf.slice(i);
  }

  frame(f) {
    let sum = 0;
    for (const v of f) sum += v * v;
    const rms = Math.sqrt(sum / f.length);
    this.chunk.push(f);
    this.levels.push(rms);

    // A pause is a clear dip below the loudness of the last second. Steady music or room
    // noise never dips, so it doesn't cause cuts; gaps between sentences do.
    let recentPeak = 0;
    for (let k = Math.max(0, this.levels.length - 33); k < this.levels.length; k++) {
      if (this.levels[k] > recentPeak) recentPeak = this.levels[k];
    }
    this.quietRun = rms < Math.max(recentPeak * 0.35, 0.0025) ? this.quietRun + 1 : 0;

    const ms = this.chunk.length * FRAME_MS;
    if (!this.levels.some((l) => l > SILENT_RMS)) {
      // Real silence: nothing to transcribe, keep only a short lead-in.
      if (ms > 2000) this.keepFrom(this.chunk.length - 10);
      return;
    }
    if (ms >= MIN_CHUNK_MS && this.quietRun * FRAME_MS >= PAUSE_MS) {
      // Cut in the middle of the pause so neither side loses the edge of a word.
      this.cut(this.chunk.length - Math.floor(this.quietRun / 2));
    } else if (ms >= MAX_CHUNK_MS) {
      this.cut(this.quietestPoint());
    } else if (ms >= FIRST_LIVE_MS && this.busy === 0 && !this.pendingFinal.length && this.worker) {
      // Live text: re-read the current stretch whenever Whisper is free.
      this.send(this.chunk, false, this.chunkSeq);
    }
  }

  // Index of the quietest ~150 ms in the last 2 seconds of the stretch.
  quietestPoint() {
    const n = this.levels.length;
    let best = n - 1;
    let bestLevel = Infinity;
    for (let i = Math.max(3, n - 67); i < n - 3; i++) {
      const level = this.levels[i - 2] + this.levels[i - 1] + this.levels[i] + this.levels[i + 1] + this.levels[i + 2];
      if (level < bestLevel) {
        bestLevel = level;
        best = i;
      }
    }
    return best;
  }

  cut(at) {
    const head = this.chunk.slice(0, at);
    const audible = this.levels.slice(0, at).some((l) => l > SILENT_RMS);
    const id = this.chunkSeq++;
    this.cutTimes.set(id, performance.now());
    for (const k of this.cutTimes.keys()) if (k < id - 3) this.cutTimes.delete(k);
    if (audible) {
      // One Whisper call costs the same for 2 s or 25 s of audio: while it is busy, collect
      // finished stretches and transcribe them together, so it never falls behind the film.
      this.pendingFinal.push(...head);
      this.pendingChunk = id;
      this.flushFinal();
    }
    this.keepFrom(at);
  }

  flushFinal() {
    if (!this.pendingFinal.length || !this.worker || this.busy > 0) return;
    const maxFrames = Math.floor(MAX_FINAL_MS / FRAME_MS);
    const frames = this.pendingFinal.length > maxFrames ? this.pendingFinal.slice(-maxFrames) : this.pendingFinal;
    this.pendingFinal = [];
    this.send(frames, true, this.pendingChunk);
  }

  keepFrom(index) {
    this.chunk = this.chunk.slice(index);
    this.levels = this.levels.slice(index);
    this.quietRun = 0;
  }

  send(frames, final, chunk) {
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((f, k) => audio.set(f, k * FRAME));
    this.busy++;
    this.worker.postMessage({ type: "transcribe", id: this.nextId++, audio, final, chunk }, [audio.buffer]);
  }
}
