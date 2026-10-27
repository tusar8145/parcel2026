/*
 * Paira Express rider app service worker (scope /rider, registered by legacy/rider/bridge-pwa.js).
 *
 * - App shell (the /rider page, its scripts, styles, icons) is cached so the app opens offline.
 *   Everything is network-first with a short timeout and falls back to the cache, so riders on
 *   a good connection always run the latest code and riders on a bad one aren't kept waiting.
 * - API calls (/api/*) are never cached here: the page keeps its own offline copy of the task
 *   list and queues actions in IndexedDB (legacy/rider/offline.js).
 * - Updates: a new version installs in the background and waits; the page shows "Update ready"
 *   and sends { type: "skip-waiting" } when the rider taps it. The very first install takes
 *   control at once so the app works offline after the first visit.
 *
 * Bump VERSION when this file or the precache list changes. Keep PRECACHE in step with
 * src/features/rider/scripts.ts.
 */
const VERSION = "2026.10.25-1";
const PREFIX = "df-rider-";
const SHELL = `${PREFIX}shell-${VERSION}`;
const RUNTIME = `${PREFIX}runtime-${VERSION}`;
const RUNTIME_MAX_ENTRIES = 200;
const NETWORK_TIMEOUT_MS = 4000;
const PAGE = "/rider";
const OFFLINE_PAGE = "/rider-offline.html";

const PRECACHE = [
  PAGE,
  OFFLINE_PAGE,
  "/rider.webmanifest",
  "/pwa/rider-192.png",
  "/pwa/rider-512.png",
  "/pwa/rider-maskable-512.png",
  "/legacy/rider/offline.js",
  "/legacy/shared/api.js",
  "/legacy/shared/select-search.js",
  "/legacy/shared/file-input.js",
  "/legacy/rider/01.js",
  "/legacy/rider/02.js",
  "/legacy/shared/support.js",
  "/legacy/shared/notifications.js",
  "/legacy/shared/scanner.js",
  "/legacy/shared/print.js",
  "/legacy/rider/bridge.js",
  "/legacy/rider/bridge-proof.js",
  "/legacy/rider/bridge-pwa.js",
  "/legacy/shared/vehicle-share.js",
  "/legacy/rider/bridge-vehicle.js",
  "/legacy/rider/bridge-account.js",
  "/legacy/rider/bridge-scan.js",
  "/legacy/shared/panel-nav.js",
];

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // One missing file must not block the install.
      await Promise.all(PRECACHE.map(url => cache.add(new Request(url, { cache: "reload" })).catch(() => undefined)));
      // First install: nothing to replace, take over straight away.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n.startsWith(PREFIX) && n !== SHELL && n !== RUNTIME).map(n => caches.delete(n)));
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", event => {
  const data = event.data || {};
  if (data.type === "skip-waiting") self.skipWaiting();
  if (data.type === "version") event.ports?.[0]?.postMessage({ version: VERSION });
  if (data.type === "cache-urls" && Array.isArray(data.urls)) {
    // The page lists what it loaded before the worker was in control (Next.js chunks, fonts).
    event.waitUntil(
      caches.open(RUNTIME).then(cache =>
        Promise.all(
          data.urls
            .filter(url => cacheable(new URL(url, self.location.origin)))
            .slice(0, 150)
            .map(url => cache.match(url).then(hit => hit || cache.add(url).catch(() => undefined))),
        ),
      ),
    );
  }
});

function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/_next/webpack-hmr") || p.startsWith("/__nextjs") || p.startsWith("/_next/image")) return false;
  return p.startsWith("/_next/static/") || p.startsWith("/legacy/") || p.startsWith("/vendor/") || p.startsWith("/pwa/") || p === "/rider.webmanifest" || p === OFFLINE_PAGE || p === "/favicon.ico";
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (url.pathname === PAGE || url.pathname.startsWith(`${PAGE}/`)) event.respondWith(navigation(event));
    return;
  }
  if (cacheable(url)) event.respondWith(networkFirst(request, PRECACHE.includes(url.pathname) ? SHELL : RUNTIME));
});

/** The rider page: network first (fresh HTML), else the cached shell, else the offline page. */
async function navigation(event) {
  const cache = await caches.open(SHELL);
  const network = (async () => {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response.ok && response.type === "basic") await cache.put(PAGE, response.clone());
    return response;
  })();
  network.catch(() => undefined); // handled below; avoid an unhandled rejection when the cache answers
  try {
    return await withTimeout(network, NETWORK_TIMEOUT_MS);
  } catch {
    const hit = await cache.match(PAGE);
    if (hit) return hit;
    // Nothing cached yet: keep waiting for a slow network, else show the offline page.
    return network.catch(async () => (await cache.match(OFFLINE_PAGE)) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } }));
  }
}

/** Network first with a short timeout; the cached copy when offline or slow. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const url = new URL(request.url);
  const key = url.pathname.startsWith("/legacy/") ? `${url.origin}${url.pathname}` : request.url.split("#")[0];
  const network = fetch(request).then(async response => {
    if (response.ok && response.type === "basic") {
      await cache.put(key, response.clone());
      if (cacheName === RUNTIME) void trim(cache);
    }
    return response;
  });
  network.catch(() => undefined);
  try {
    return await withTimeout(network, NETWORK_TIMEOUT_MS);
  } catch {
    const hit = (await cache.match(key)) || (await caches.match(key));
    return hit || network;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network timeout")), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - RUNTIME_MAX_ENTRIES))) await cache.delete(key);
}
