// English → Russian translation with an open model (Opus-MT) running in the browser.
// Free, no key, and works where Chrome's built-in translator doesn't (phones, Safari, Firefox).
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
const REPOS = ["Xenova/opus-mt-en-ru"];

let translator = null;
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

async function load() {
  if (translator) return;
  const { pipeline } = await import(TRANSFORMERS_URL);
  let saved = false;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== "progress" || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    self.postMessage({ type: "progress", loaded, total, saved });
  };
  let lastError;
  for (const repo of REPOS) {
    saved = await isSaved(repo);
    for (const dtype of ["q8", "fp32"]) {
      try {
        translator = await pipeline("translation", repo, { dtype, progress_callback });
        return;
      } catch (err) {
        lastError = err;
        console.warn(`Could not load ${repo} (${dtype}):`, err);
      }
    }
  }
  throw new Error(`Couldn't load the translation model: ${lastError?.message || lastError}`);
}

async function handle({ type, id, texts }) {
  if (type === "load") {
    await load();
    self.postMessage({ type: "result", id, texts: [] });
    return;
  }
  if (type !== "translate") return;
  await load();
  const out = await translator(texts, { max_new_tokens: 256 });
  self.postMessage({ type: "result", id, texts: out.map((o) => o.translation_text) });
}
