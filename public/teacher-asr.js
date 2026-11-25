// The AI teacher's ears: the microphone streamed to Deepgram Flux STT Multilingual, which hears
// English and Russian (even mixed in one sentence) and itself tells when she has finished her
// turn, so the teacher neither cuts her off nor waits too long. If Flux can't be reached, Nova-3
// (language=multi) with an end-of-turn timer of our own does the same job.

const SAMPLE_RATE = 16000;
const CHUNK = 1280; // 80 ms, what Flux works best with

/** Flux: English and Russian, patient with pauses (learners stop to think), eager hints on. */
export const fluxListenUrl = () => "wss://api.deepgram.com/v2/listen?" + new URLSearchParams([
  ["model", "flux-general-multi"],
  ["language_hint", "en"],
  ["language_hint", "ru"],
  ["encoding", "linear16"],
  ["sample_rate", String(SAMPLE_RATE)],
  ["eot_threshold", "0.75"],
  ["eager_eot_threshold", "0.5"],
  ["eot_timeout_ms", "4000"],
]);

export const novaListenUrl = () => "wss://api.deepgram.com/v1/listen?" + new URLSearchParams({
  model: "nova-3",
  language: "multi",
  encoding: "linear16",
  sample_rate: String(SAMPLE_RATE),
  channels: "1",
  interim_results: "true",
  smart_format: "true",
  endpointing: "500",
  utterance_end_ms: "1500",
  vad_events: "true",
});

const NOVA_TURN_GAP = 900; // ms of quiet after a finished phrase before her turn is over

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("teacher-capture", Capture);
`;

/**
 * Events: onStart(text) her turn began (barge-in point); onUpdate(text) words so far;
 * onEager(text) she has probably finished; onResumed() she went on after all;
 * onEnd(text, languages) her turn is over; onLevel(0…1) loudness, for the meter;
 * onError(message); onStatus(text).
 */
export class TeacherEars {
  constructor(events, getToken) {
    this.e = events;
    this.getToken = getToken;
    this.ws = null;
    this.ctx = null;
    this.muted = false;
    this.mode = "flux";
    this.buffer = new Int16Array(CHUNK);
    this.filled = 0;
    this.session = 0;
    this.failures = [];
    // Nova only
    this.parts = [];
    this.interim = "";
    this.inTurn = false;
    this.endTimer = null;
  }

  async start(stream) {
    const session = ++this.session;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, "teacher-capture");
    this.ctx.createMediaStreamSource(stream).connect(node);
    node.port.onmessage = ({ data }) => this.onAudio(data);
    try {
      await this.connect(session);
    } catch (err) {
      if (this.session !== session) return;
      this.mode = "nova"; // Flux refused (or isn't available to this key): the older model
      await this.connect(session);
    }
  }

  async connect(session) {
    const token = await this.getToken();
    if (this.session !== session) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.mode === "flux" ? fluxListenUrl() : novaListenUrl(), ["bearer", token]);
      ws.binaryType = "arraybuffer";
      let opened = false;
      ws.onopen = () => {
        opened = true;
        if (this.session !== session) { ws.close(); return resolve(); }
        this.ws = ws;
        resolve();
      };
      ws.onmessage = ({ data }) => {
        try { this.onMessage(JSON.parse(data)); } catch { /* not JSON */ }
      };
      ws.onclose = (event) => {
        if (!opened) return reject(new Error(`Speech recognition refused the connection (${event.code})`));
        if (this.ws === ws) this.ws = null;
        if (this.session === session) this.reconnect(session);
      };
    });
  }

  async reconnect(session) {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 30000);
    this.failures.push(now);
    if (this.failures.length > 4) {
      this.session++;
      this.e.onError?.("Связь с распознаванием речи потеряна. Проверьте интернет.");
      return;
    }
    this.e.onStatus?.("reconnecting");
    await new Promise((r) => setTimeout(r, 400 * this.failures.length));
    if (this.session !== session) return;
    try {
      await this.connect(session);
      this.e.onStatus?.("listening");
    } catch {
      if (this.session === session) this.reconnect(session);
    }
  }

  onAudio(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = this.muted ? 0 : Math.max(-1, Math.min(1, samples[i]));
      sum += s * s;
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === CHUNK) {
        // Muted, she isn't heard, but the stream goes on (silence), so the connection stays open.
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.buffer.buffer.slice(0));
        this.filled = 0;
      }
    }
    this.e.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 6));
  }

  onMessage(msg) {
    if (this.mode === "flux") {
      if (msg.type !== "TurnInfo") {
        if (msg.type === "Error") console.warn("Deepgram listen:", msg.code ?? "", msg.description ?? msg.message ?? "");
        return;
      }
      const text = (msg.transcript ?? "").trim();
      switch (msg.event) {
        case "StartOfTurn": this.e.onStart?.(text); break;
        case "Update": if (text) this.e.onUpdate?.(text); break;
        case "EagerEndOfTurn": this.e.onEager?.(text); break;
        case "TurnResumed": this.e.onResumed?.(); break;
        case "EndOfTurn": if (text) this.e.onEnd?.(text, msg.languages ?? []); break;
        default:
      }
      return;
    }
    // Nova: words while she speaks; her turn ends after a finished phrase and a short quiet.
    if (msg.type === "UtteranceEnd") return this.novaQuiet();
    if (msg.type !== "Results") return;
    const text = (msg.channel?.alternatives?.[0]?.transcript ?? "").trim();
    if (!text) return;
    clearTimeout(this.endTimer);
    if (!this.inTurn) {
      this.inTurn = true;
      this.e.onStart?.(text);
    }
    if (msg.is_final) {
      this.parts.push(text);
      this.interim = "";
      this.e.onUpdate?.(this.parts.join(" "));
      if (msg.speech_final) this.novaQuiet();
    } else {
      this.interim = text;
      this.e.onUpdate?.([...this.parts, text].join(" "));
    }
  }

  novaQuiet(delay = NOVA_TURN_GAP) {
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      const text = [...this.parts, this.interim].join(" ").trim();
      this.parts = [];
      this.interim = "";
      this.inTurn = false;
      if (text) this.e.onEnd?.(text, []);
    }, delay);
  }

  /** Ends her turn now (she tapped "done"). */
  finishTurn() {
    if (this.mode === "flux") {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "ForceEndTurn" }));
    } else {
      this.novaQuiet(0);
    }
  }

  mute(on) {
    this.muted = Boolean(on);
  }

  stop() {
    this.session++;
    clearTimeout(this.endTimer);
    try {
      this.ws?.send(JSON.stringify({ type: "CloseStream" }));
    } catch { /* already closed */ }
    this.ws?.close();
    this.ws = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.filled = 0;
    this.parts = [];
    this.inTurn = false;
  }
}
