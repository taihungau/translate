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
async function savedUrls() {
  try {
    return (await (await caches.open("transformers-cache")).keys()).map((r) => r.url);
  } catch {
    return [];
  }
}
const isSavedFile = (urls, repo, file) => urls.some((u) => u.includes(`/${repo}/`) && u.endsWith(`/${file}`));

// File name suffix transformers.js uses for each format.
const SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };
function modelFiles(dtype) {
  const enc = typeof dtype === "string" ? dtype : dtype.encoder_model;
  const dec = typeof dtype === "string" ? dtype : dtype.decoder_model_merged;
  return [`onnx/encoder_model${SUFFIX[enc] ?? ""}.onnx`, `onnx/decoder_model_merged${SUFFIX[dec] ?? ""}.onnx`];
}

// Which GPU features this computer has: WebGPU at all, and 16-bit floats (most recent GPUs,
// including Apple silicon), which halve the size of the biggest model files.
async function gpuSupport() {
  try {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
    return { gpu: Boolean(adapter), f16: Boolean(adapter?.features?.has("shader-f16")) };
  } catch {
    return { gpu: false, f16: false };
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

  const { gpu, f16 } = await gpuSupport();
  const device = gpu ? "webgpu" : "wasm";
  // Smallest formats first: a half-precision encoder (half the download, faster on the GPU)
  // and a 4-bit decoder. Not every model repo ships every variant, so fall back as needed.
  const dtypes = dtypeOverrides?.[device] ?? (device === "webgpu"
    ? [
        ...(f16 ? [{ encoder_model: "fp16", decoder_model_merged: "q4" }] : []),
        { encoder_model: "fp32", decoder_model_merged: "q4" },
        { encoder_model: "fp32", decoder_model_merged: "fp32" },
      ]
    : ["q8", "fp32"]);

  // Try every repo/format combination, but ones already saved on this device first, so an
  // earlier download is reused instead of fetching a different variant.
  const urls = await savedUrls();
  const candidates = repos.flatMap((repo) => dtypes.map((dtype) => ({ repo, dtype })));
  const isSavedCandidate = ({ repo, dtype }) => modelFiles(dtype).every((f) => isSavedFile(urls, repo, f));
  candidates.sort((a, b) => isSavedCandidate(b) - isSavedCandidate(a));

  let repo = "";
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== "progress" || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total, saved: isSavedFile(urls, repo, p.file) });
    let loadedBytes = 0;
    let totalBytes = 0;
    let saved = true;
    for (const f of files.values()) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
      if (!f.saved && f.loaded < f.total) saved = false;
    }
    self.postMessage({ type: "progress", loaded: loadedBytes, total: totalBytes, saved });
  };

  let lastError;
  for (const candidate of candidates) {
    repo = candidate.repo;
    const { dtype } = candidate;
    files.clear();
    {
      try {
        asr = await transformers.pipeline("automatic-speech-recognition", repo, { device, dtype, progress_callback });
        // The first run compiles GPU shaders; do it now rather than on the first line of dialogue.
        self.postMessage({ type: "phase", phase: "warmup", device });
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
