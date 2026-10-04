// Keeps the app and its speech/translation library available offline (a cinema may have no
// signal). The models themselves are stored by transformers.js in its own cache.
const CACHE = "subtitle-app-v7";
const APP_FILES = ["./", "index.html", "style.css", "app.js", "subtitles.js", "local-asr.js", "asr-worker.js", "mt-worker.js", "cloud-asr.js", "img/laser-eyes.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("subtitle-app-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // The library and its WebAssembly files: versioned URLs, so a saved copy never goes stale.
  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // The app itself: use the network when online (so updates arrive), the saved copy offline.
  if (url.origin === self.location.origin && !url.pathname.startsWith("/api/")) {
    event.respondWith(
      // Always ask the server for the latest version (bypassing the HTTP cache) when online.
      fetch(request, { cache: "no-cache" })
        .then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
    );
  }
});
