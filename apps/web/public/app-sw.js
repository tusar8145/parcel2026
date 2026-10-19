const VERSION = "2026.10.20-1";
const CACHE = `delivery-fast-static-${VERSION}`;
const MAX_ENTRIES = 250;

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith("delivery-fast-static-") && name !== CACHE).map(name => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !isStaticAsset(url.pathname)) return;
  event.respondWith(cacheStaticAsset(request));
});

function isStaticAsset(pathname) {
  return pathname.startsWith("/legacy/") || pathname.startsWith("/_next/static/") || pathname.startsWith("/vendor/") || pathname.startsWith("/pwa/");
}

async function cacheStaticAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
    trim(cache);
  }
  return response;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
}
