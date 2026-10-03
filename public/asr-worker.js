// Runs a speech-to-text model on this computer (WebGPU when available, otherwise WebAssembly)
// so the page stays responsive. Messages are handled strictly in order.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

let transformers = null;
let asr = null;
let loaded = null; // { key, kind, device }
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch((err) => {
    self.postMessage({ type: "error", id: data.id, message: err?.message || String(err) });
  });
};

// Models are saved by transformers.js in Cache Storage after the first download.
async function isSaved(repo) {
  try {
    const keys = await (await caches.open("transformers-cache")).keys();
    return keys.some((r) => r.url.includes(`/${repo}/`));
  } catch {
    return false;
  }
}

async function hasWebGPU() {
  try {
    return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function handle(msg) {
  if (msg.type === "load") return load(msg);
  if (msg.type === "transcribe") return transcribe(msg);
}

async function load({ key, kind, repos, dtypes: dtypeOverrides }) {
  if (loaded?.key === key) {
    self.postMessage({ type: "ready", device: loaded.device });
    return;
  }
  transformers ??= await import(TRANSFORMERS_URL);
  if (asr) {
    await asr.dispose?.();
    asr = null;
    loaded = null;
  }

  const device = (await hasWebGPU()) ? "webgpu" : "wasm";
  // Quantised decoders keep downloads small. Not every model repo ships every variant,
  // so try a few formats before giving up.
  const dtypes = dtypeOverrides?.[device] ?? (device === "webgpu"
    ? [{ encoder_model: "fp32", decoder_model_merged: "q4" }, { encoder_model: "fp32", decoder_model_merged: "fp32" }]
    : ["q8", "fp32"]);

  let saved = false;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== "progress" || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const f of files.values()) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
    }
    self.postMessage({ type: "progress", loaded: loadedBytes, total: totalBytes, saved });
  };

  let lastError;
  for (const repo of repos) {
    saved = await isSaved(repo);
    for (const dtype of dtypes) {
      try {
        asr = await transformers.pipeline("automatic-speech-recognition", repo, { device, dtype, progress_callback });
        // The first run compiles GPU shaders; do it now rather than on the first line of dialogue.
        await asr(new Float32Array(16000), optionsFor(kind, 1));
        loaded = { key, kind, device };
        self.postMessage({ type: "ready", device });
        return;
      } catch (err) {
        lastError = err;
        console.warn(`Could not load ${repo} (${JSON.stringify(dtype)}):`, err);
      }
    }
  }
  throw new Error(`Couldn't load the speech model: ${lastError?.message || lastError}`);
}

function optionsFor(kind, seconds) {
  // Cap output at a fast speaking rate so a model can't loop on noise for long.
  const max_new_tokens = Math.ceil(seconds * 7) + 8;
  if (kind === "whisper-multi") return { language: "english", task: "transcribe", max_new_tokens };
  return { max_new_tokens };
}

async function transcribe({ id, audio, final, chunk }) {
  if (!asr) throw new Error("Speech model is not loaded");
  const started = performance.now();
  const out = await asr(audio, optionsFor(loaded.kind, audio.length / 16000));
  const ms = Math.round(performance.now() - started);
  self.postMessage({ type: "result", id, final, chunk, ms, seconds: audio.length / 16000, text: (out?.text || "").trim() });
}
