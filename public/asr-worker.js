// Runs Whisper in its own thread so the page stays responsive. Messages are handled in order.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

let asr = null;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch((err) => {
    self.postMessage({ type: "error", id: data.id, message: err?.message || String(err) });
  });
};

async function handle(msg) {
  if (msg.type === "load") return load(msg);
  if (msg.type === "transcribe") return transcribe(msg);
}

async function savedUrls() {
  try {
    return (await (await caches.open("transformers-cache")).keys()).map((r) => r.url);
  } catch {
    return [];
  }
}

async function load({ repo, dtype }) {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) {
    throw new Error("This needs Chrome or Edge on a computer whose graphics chip supports WebGPU (any recent Mac or PC).");
  }
  // Half precision needs 16-bit float support (all Apple silicon Macs and most recent GPUs).
  // Without it, fall back to the full-precision encoder: same accuracy, about twice the size.
  const useDtype = adapter.features.has("shader-f16") ? dtype : { ...dtype, encoder_model: "fp32" };

  const { pipeline } = await import(TRANSFORMERS_URL);
  const urls = await savedUrls();
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== "progress" || !p.total) return;
    const saved = urls.some((u) => u.includes(`/${repo}/`) && u.endsWith(`/${p.file}`));
    files.set(p.file, { loaded: p.loaded, total: p.total, saved });
    let loaded = 0;
    let total = 0;
    let allSaved = true;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
      if (!f.saved) allSaved = false;
    }
    self.postMessage({ type: "progress", loaded, total, saved: allSaved });
  };

  asr = await pipeline("automatic-speech-recognition", repo, { device: "webgpu", dtype: useDtype, progress_callback });
  // The first run compiles the GPU programs; do it now rather than on the first line of dialogue.
  self.postMessage({ type: "phase", phase: "warmup" });
  await asr(new Float32Array(16000), { language: "english", task: "transcribe" });
  self.postMessage({ type: "ready", device: "webgpu" });
}

async function transcribe({ id, audio, final, chunk }) {
  if (!asr) throw new Error("The speech model is not loaded");
  const started = performance.now();
  const seconds = audio.length / 16000;
  const out = await asr(audio, {
    language: "english",
    task: "transcribe",
    // Cap output at a fast speaking rate so the model can't loop on noise for long.
    max_new_tokens: Math.ceil(seconds * 7) + 8,
    // Never repeat the same 4 words: stops the loops Whisper produces over music.
    no_repeat_ngram_size: 4,
  });
  const ms = Math.round(performance.now() - started);
  self.postMessage({ type: "result", id, final, chunk, ms, text: (out?.text || "").trim() });
}
