// Live speech recognition with Deepgram Nova-3: microphone audio is streamed (16 kHz, 16-bit)
// over a WebSocket and words come back while they are spoken. Works in any browser, including
// phones. The server hands out short-lived tokens, so the Deepgram API key stays on the server.

const SAMPLE_RATE = 16000;
const SEND_EVERY = 1600; // samples (100 ms) per message
const MAX_LINE_CHARS = 160; // a run-on line is finished here so translations stay short

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen?" + new URLSearchParams({
  model: "nova-3",
  language: "en",
  encoding: "linear16",
  sample_rate: String(SAMPLE_RATE),
  channels: "1",
  interim_results: "true", // words while they are being spoken
  smart_format: "true", // punctuation, capitals, numbers
  endpointing: "300", // a 300 ms pause ends a sentence
  utterance_end_ms: "1000", // ...or 1 s without words, even over music
});

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

export class CloudRecognizer {
  /**
   * @param {{onInterim(text: string): void, onFinal(text: string, opts: {show: boolean}): void,
   *          onError(message: string): void, onStatus(text: string): void}} handlers
   * @param {() => Promise<string>} getToken returns a short-lived Deepgram token
   */
  constructor(handlers, getToken) {
    this.h = handlers;
    this.getToken = getToken;
    this.active = false;
    this.ws = null;
    this.ctx = null;
    this.parts = []; // finished pieces of the current sentence
    this.buffer = new Int16Array(SEND_EVERY);
    this.filled = 0;
    this.failures = [];
  }

  async start(stream) {
    this.active = true;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, "capture");
    this.ctx.createMediaStreamSource(stream).connect(node);
    node.port.onmessage = ({ data }) => this.onAudio(data);
    await this.connect();
    // Deepgram closes idle connections; keep it open through silent scenes.
    this.keepAlive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);
  }

  async connect() {
    const token = await this.getToken();
    if (!this.active) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(DEEPGRAM_URL, ["bearer", token]);
      ws.binaryType = "arraybuffer";
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.ws = ws;
        resolve();
      };
      ws.onmessage = ({ data }) => {
        try {
          this.onResult(JSON.parse(data));
        } catch { /* ignore non-JSON */ }
      };
      ws.onclose = (event) => {
        if (!opened) {
          reject(new Error(`Couldn't connect to Deepgram (${event.code}${event.reason ? `: ${event.reason}` : ""}).`));
          return;
        }
        if (this.ws === ws) this.ws = null;
        if (this.active) this.reconnect();
      };
    });
  }

  // Connections drop on flaky mobile networks; reconnect, but give up if it keeps failing.
  async reconnect() {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 30000);
    this.failures.push(now);
    if (this.failures.length > 4) {
      this.active = false;
      this.h.onError("Lost the connection to Deepgram. Check the internet connection and press Start again.");
      return;
    }
    this.h.onStatus("Reconnecting…");
    await new Promise((r) => setTimeout(r, 500 * this.failures.length));
    try {
      await this.connect();
      this.h.onStatus("Listening…");
    } catch (err) {
      if (this.active) this.reconnect();
    }
  }

  onAudio(samples) {
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === SEND_EVERY) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.buffer.buffer.slice(0));
        this.filled = 0;
      }
    }
  }

  onResult(msg) {
    if (msg.type === "UtteranceEnd") {
      this.finishLine();
      return;
    }
    if (msg.type !== "Results") return;
    const text = (msg.channel?.alternatives?.[0]?.transcript || "").trim();
    if (msg.is_final) {
      if (text) this.parts.push(text);
      const line = this.parts.join(" ");
      if (msg.speech_final || line.length > MAX_LINE_CHARS) this.finishLine();
      else if (line) this.h.onInterim(line);
    } else if (text) {
      this.h.onInterim([...this.parts, text].join(" "));
    }
  }

  finishLine() {
    const line = this.parts.join(" ").trim();
    this.parts = [];
    if (line) this.h.onFinal(line, { show: true });
  }

  stop() {
    this.active = false;
    clearInterval(this.keepAlive);
    try {
      this.ws?.send(JSON.stringify({ type: "CloseStream" }));
    } catch { /* already closed */ }
    this.ws?.close();
    this.ws = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.parts = [];
    this.filled = 0;
  }
}
