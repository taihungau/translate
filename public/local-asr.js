// On-device speech recognition: captures microphone audio at 16 kHz, cuts it into chunks at
// natural pauses, and transcribes them with Whisper or Moonshine in a worker (asr-worker.js).
// No audio is thrown away: in a cinema, dialogue sits on top of music and effects, so a
// loudness gate would miss words. Loudness is only used to choose where to cut.

export const LOCAL_MODELS = {
  "moonshine-tiny": { kind: "moonshine", repos: ["onnx-community/moonshine-tiny-ONNX"] },
  "moonshine-base": { kind: "moonshine", repos: ["onnx-community/moonshine-base-ONNX"] },
  "whisper-tiny": { kind: "whisper", repos: ["onnx-community/whisper-tiny.en", "Xenova/whisper-tiny.en"] },
  "whisper-base": { kind: "whisper", repos: ["onnx-community/whisper-base.en", "Xenova/whisper-base.en"] },
  "whisper-small": { kind: "whisper", repos: ["onnx-community/whisper-small.en", "Xenova/whisper-small.en"] },
  "distil-small": { kind: "whisper", repos: ["onnx-community/distil-small.en", "Xenova/distil-small.en"] },
  "whisper-turbo": {
    kind: "whisper-multi", // multilingual model: told to transcribe English
    repos: ["onnx-community/whisper-large-v3-turbo"],
    // The full-precision encoder is ~2.5 GB; half precision keeps it near 1 GB.
    dtypes: {
      webgpu: [{ encoder_model: "fp16", decoder_model_merged: "q4" }, { encoder_model: "q4", decoder_model_merged: "q4" }],
      wasm: ["q8"],
    },
  },
};

const SAMPLE_RATE = 16000;
const FRAME = 480; // 30 ms
const FRAME_MS = 30;
const PAUSE_MS = 300; // a dip this long counts as a pause between phrases
const MIN_CHUNK_MS = 2500; // models are much more accurate with a few seconds of context
const MAX_CHUNK_MS = 6000; // long run-on speech is cut at its quietest point before this
const INTERIM_EVERY_MS = 600;
const SILENT_RMS = 0.002; // below this nothing is audible at all

// Whisper and Moonshine invent text for music, applause and silence.
const JUNK = /^(thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+|-+|so\.?)$/i;

export function cleanTranscript(text) {
  const cleaned = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ") // [Music], (laughs), *sighs*, ♪
    .replace(/\s+/g, " ")
    // Over music the models sometimes loop: "go go go go", "I'm here. I'm here. I'm here."
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
   * @param {{onInterim(text: string): void, onFinal(text: string): void,
   *          onStatus(text: string): void, onError(message: string): void}} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    this.worker = null;
    this.modelKey = null;
    this.ready = null;
    this.busy = 0;
    this.nextId = 0;
    this.ctx = null;
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        const pct = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
        const mb = Math.round(data.total / 1e6);
        this.h.onStatus(`Downloading speech model… ${pct}% of ${mb} MB (only the first time)`);
      } else if (data.type === "ready") {
        this.readyResolve?.(data.device);
      } else if (data.type === "result") {
        this.busy--;
        const text = cleanTranscript(data.text);
        if (text) (data.final ? this.h.onFinal : this.h.onInterim)(text);
      } else if (data.type === "error") {
        if (data.id !== undefined) this.busy--;
        if (this.readyReject && data.id === undefined) this.readyReject(new Error(data.message));
        else this.h.onError(data.message);
      }
    };
  }

  /** Download (first time only) and load a model. Resolves with "webgpu" or "wasm". */
  load(modelKey) {
    if (this.modelKey === modelKey && this.ready) return this.ready;
    this.ensureWorker();
    this.modelKey = modelKey;
    this.h.onStatus("Loading speech model…");
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    }).finally(() => {
      this.readyResolve = this.readyReject = null;
    });
    this.ready.catch(() => { this.ready = null; this.modelKey = null; });
    this.worker.postMessage({ type: "load", key: modelKey, ...LOCAL_MODELS[modelKey] });
    return this.ready;
  }

  async start(stream) {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, "capture");
    this.ctx.createMediaStreamSource(stream).connect(node);
    this.resetVad();
    node.port.onmessage = ({ data }) => this.feed(data);
  }

  stop() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  resetVad() {
    this.carry = new Float32Array(0);
    this.chunk = []; // frames since the last cut
    this.levels = []; // loudness of each frame in the chunk
    this.quietRun = 0;
    this.lastInterim = performance.now();
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
    const audible = this.levels.some((l) => l > SILENT_RMS);

    if (!audible) {
      // Real silence: nothing to transcribe, keep only a short lead-in.
      if (ms > 2000) this.keepFrom(this.chunk.length - 10);
      return;
    }
    if (ms >= MIN_CHUNK_MS && this.quietRun * FRAME_MS >= PAUSE_MS) {
      // Cut in the middle of the pause so neither side loses the edge of a word.
      this.cut(this.chunk.length - Math.floor(this.quietRun / 2));
    } else if (ms >= MAX_CHUNK_MS) {
      this.cut(this.quietestPoint());
    } else if (ms >= 700 && this.busy === 0 && performance.now() - this.lastInterim >= INTERIM_EVERY_MS) {
      // Partial result so subtitles start while the sentence is still going.
      this.lastInterim = performance.now();
      this.send(this.chunk, false);
    }
  }

  // Index of the quietest ~150 ms in the last 2 seconds of the chunk.
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
    if (this.levels.slice(0, at).some((l) => l > SILENT_RMS)) this.send(head, true);
    this.keepFrom(at);
    this.lastInterim = performance.now();
  }

  keepFrom(index) {
    this.chunk = this.chunk.slice(index);
    this.levels = this.levels.slice(index);
    this.quietRun = 0;
  }

  send(frames, final) {
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((f, k) => audio.set(f, k * FRAME));
    this.busy++;
    this.worker.postMessage({ type: "transcribe", id: this.nextId++, audio, final }, [audio.buffer]);
  }
}
