// i.inc's service worker: it keeps the app shell so the app opens when the daemon can't be reached.
//
// - Install: precache the shell (index.html, the hashed assets, the manifest and icons). The two
//   placeholders below are filled in by the build (precachePlugin in vite.config.ts).
// - Navigations: network first, so a new build shows up straight away. If the network fails or the
//   daemon answers 5xx, serve the cached shell. The app itself then shows "Can't reach i.inc".
// - /assets/* (hashed, so immutable) and the other static files: cache first, filled on use.
// - /api/*: never touched. No response from the daemon is cached or answered from the cache.
//
// Push (T8, T65, contract C2): `push` shows the daemon's notification and `notificationclick` opens it. Every
// push shows something (a push that shows nothing spends Chrome's silent-push allowance, and Apple revokes
// the subscription for it); the app closes stale notifications itself (src/notifications.ts). They are at the bottom; the fetch handler above is untouched.

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

// ---- Push notifications (contract C2: { title, body, url, tag? }) ----

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "i.inc";
  const url = typeof payload.url === "string" ? payload.url : "";
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : url || "i-inc";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === "string" ? payload.body : "",
      // One notification per ticket (or per explicit tag, such as a conversation): a newer one replaces the
      // older and still alerts.
      tag,
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

/** Where a tap goes: the payload's url if it is on this origin, otherwise the app's front door. */
function notificationTarget(url) {
  try {
    const target = new URL(url, `${self.location.origin}/`);
    if (target.origin === self.location.origin) return target.href;
  } catch {
    // Not a URL at all: fall through.
  }
  return `${self.location.origin}/`;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  const target = notificationTarget(typeof url === "string" ? url : "");
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        const focused = (await open.focus().catch(() => null)) ?? open;
        // A change of #hash is a same-document navigation, so the open app just moves to the ticket.
        if (typeof focused.navigate === "function") await focused.navigate(target).catch(() => {});
        // Not every browser lets a worker navigate a window (iOS does not), and an app that is already at
        // this address has nothing to navigate to: tell the app where to go, and it focuses the card itself.
        if (typeof focused.postMessage === "function")
          focused.postMessage({ type: "i-inc:open", url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
