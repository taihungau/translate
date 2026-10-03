// On-device speech recognition: captures microphone audio at 16 kHz, splits it into phrases
// at pauses, and transcribes them with Whisper or Moonshine in a worker (asr-worker.js).

export const LOCAL_MODELS = {
  "moonshine-tiny": { kind: "moonshine", repos: ["onnx-community/moonshine-tiny-ONNX"] },
  "moonshine-base": { kind: "moonshine", repos: ["onnx-community/moonshine-base-ONNX"] },
  "whisper-tiny": { kind: "whisper", repos: ["onnx-community/whisper-tiny.en", "Xenova/whisper-tiny.en"] },
  "whisper-base": { kind: "whisper", repos: ["onnx-community/whisper-base.en", "Xenova/whisper-base.en"] },
  "whisper-small": { kind: "whisper", repos: ["onnx-community/whisper-small.en", "Xenova/whisper-small.en"] },
};

const SAMPLE_RATE = 16000;
const FRAME = 480; // 30 ms
const FRAME_MS = 30;
const PRE_ROLL_FRAMES = 10; // keep 300 ms before speech starts so first syllables aren't cut
const END_SILENCE_MS = 550; // a pause this long ends a phrase
const MAX_PHRASE_MS = 8000; // long run-on speech is cut here
const MIN_SPEECH_MS = 300; // ignore clicks and short noises
const INTERIM_EVERY_MS = 900;

// Whisper and Moonshine invent text for music, applause and silence.
const JUNK = /^(thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+|-+|so\.?)$/i;

export function cleanTranscript(text) {
  const cleaned = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ") // [Music], (laughs), *sighs*, ♪
    .replace(/\s+/g, " ")
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
    this.preRoll = [];
    this.phrase = null; // array of frames while someone is speaking
    this.silentFrames = 0;
    this.noiseFloor = 0.01;
    this.lastInterim = 0;
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
    // Speech is anything clearly louder than the recent background level (music, room noise).
    const threshold = Math.max(this.noiseFloor * 2.2, 0.004);
    const loud = rms > threshold;

    if (!this.phrase) {
      this.noiseFloor = 0.97 * this.noiseFloor + 0.03 * rms;
      this.preRoll.push(f);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      if (loud) {
        this.phrase = [...this.preRoll];
        this.preRoll = [];
        this.silentFrames = 0;
        this.loudFrames = 1;
        this.lastInterim = performance.now();
      }
      return;
    }

    this.noiseFloor = 0.998 * this.noiseFloor + 0.002 * rms;
    this.phrase.push(f);
    this.silentFrames = loud ? 0 : this.silentFrames + 1;
    if (loud) this.loudFrames++;
    const ms = this.phrase.length * FRAME_MS;

    if (this.silentFrames * FRAME_MS >= END_SILENCE_MS) {
      const speech = this.phrase.slice(0, this.phrase.length - this.silentFrames + 3);
      this.phrase = null;
      if (this.loudFrames * FRAME_MS >= MIN_SPEECH_MS) this.send(speech, true);
    } else if (ms >= MAX_PHRASE_MS) {
      this.send(this.phrase, true);
      this.phrase = [];
      this.loudFrames = 0;
      this.lastInterim = performance.now();
    } else if (ms >= 1000 && this.busy === 0 && performance.now() - this.lastInterim >= INTERIM_EVERY_MS) {
      // Partial result so subtitles start while the sentence is still going.
      this.lastInterim = performance.now();
      this.send(this.phrase, false);
    }
  }

  send(frames, final) {
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((f, k) => audio.set(f, k * FRAME));
    this.busy++;
    this.worker.postMessage({ type: "transcribe", id: this.nextId++, audio, final }, [audio.buffer]);
  }
}
