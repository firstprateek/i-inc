// i.inc's service worker: it keeps the app shell so the app opens when the daemon can't be reached.
//
// - Install: precache the shell (index.html, the hashed assets, the manifest and icons). The two
//   placeholders below are filled in by the build (precachePlugin in vite.config.ts).
// - Navigations: network first, so a new build shows up straight away. If the network fails or the
//   daemon answers 5xx, serve the cached shell. The app itself then shows "Can't reach i.inc".
// - /assets/* (hashed, so immutable) and the other static files: cache first, filled on use.
// - /api/*: never touched. No response from the daemon is cached or answered from the cache.
//
// To add a feature (push, T8), add listeners at the bottom. Keep the fetch handler above untouched.

const VERSION = "__BUILD_ID__";
const PRECACHE = "__PRECACHE__";

const CACHE = `i-inc-shell-${VERSION}`;
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  const urls = Array.isArray(PRECACHE) ? PRECACHE : [];
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(urls))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n.startsWith("i-inc-shell-") && n !== CACHE).map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // the daemon's answers are never cached

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    if (response.status < 500) return response;
  } catch {
    // Offline, or the daemon is down: fall through to the cached shell.
  }
  const cache = await caches.open(CACHE);
  return (await cache.match(SHELL)) ?? Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Only remember real files. The daemon answers an unknown path with index.html, which isn't one.
  const type = response.headers.get("content-type") ?? "";
  if (response.ok && !type.includes("text/html")) cache.put(request, response.clone());
  return response;
}
