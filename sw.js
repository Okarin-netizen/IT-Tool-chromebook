// One service worker for the whole site. Each page tells it which files to keep for offline use.
const CACHE = "itc-v1";
const SCOPE = new URL("./", self.location).href; // …/IT-Tool-chromebook/
const VENDOR = SCOPE + "shared/vendor/";
// Cache names used by the old per-tool workers, removed once those workers are gone.
const LEGACY = /^(pdf-text|pdf-pages|image-pdf|calc|todo|timer|image-annotate|pdf-compress|pdf-image|pdf-stamp|pdf-extract|pdf-sign|pdf-grade)-v\d+$/;

self.addEventListener("install", () => self.skipWaiting());

// Only this site's own caches are touched: other sites on the same domain keep theirs.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("itc-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const { type, urls } = event.data || {};
  if (type === "precache") event.waitUntil(precache(urls || []));
  if (type === "drop-legacy") event.waitUntil(dropLegacy());
});

// Fetches only what is not stored yet, so the 5MB font is not downloaded on every visit.
async function precache(urls) {
  const cache = await caches.open(CACHE);
  for (const url of urls) {
    if (!url.startsWith(SCOPE) || (await cache.match(url))) continue;
    try {
      await cache.add(url);
    } catch {
      // Tried again on the next visit.
    }
  }
}

async function dropLegacy() {
  for (const key of await caches.keys()) if (LEGACY.test(key)) await caches.delete(key);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith(SCOPE)) return;
  event.respondWith(req.url.startsWith(VENDOR) ? cacheFirst(req) : networkFirst(req));
});

// Libraries live in versioned folders and never change, so the stored copy is used first.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200) await cache.put(req, res.clone()).catch(() => {});
  return res;
}

// The tools' own files: network first so updates show up, the stored copy when offline.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.status === 200) await cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
