// The service worker for apps/web (hand-written, no build plugin). It caches the app's static
// files and an offline page, and never touches the chat's API or auth.
//
// Served from the root so its scope covers the whole app. Registered in production builds only
// (see src/lib/service-worker.ts). The routing and age decisions live in sw-logic.js, which the
// unit tests load too.

importScripts("/sw-logic.js");
const { routeOf, isStale } = self.swLogic;

const ASSET_CACHE = "ai-chat-assets";
const OFFLINE_CACHE = "ai-chat-offline";
const OFFLINE_URL = "/offline.html";
const CACHED_AT_HEADER = "x-cached-at";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      // Take over at once: a new version doesn't wait for every tab to close.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await trimAssets();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const route = routeOf(
    { method: request.method, url: request.url, mode: request.mode },
    self.location.origin,
  );
  if (route === "navigate") event.respondWith(networkFirstWithOfflinePage(request));
  else if (route === "asset") event.respondWith(cacheFirst(request, event));
});

/** Hashed build assets never change under their name, so a cached copy is always current. */
async function cacheFirst(request, event) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) event.waitUntil(storeAsset(cache, request, response.clone()));
  return response;
}

async function storeAsset(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  const body = await response.blob();
  await cache.put(
    request,
    new Response(body, { status: response.status, statusText: response.statusText, headers }),
  );
}

/** Pages are never cached (they're the signed-in user's data); only the offline page is. */
async function networkFirstWithOfflinePage(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(OFFLINE_CACHE);
    return (await cache.match(OFFLINE_URL)) ?? Response.error();
  }
}

async function trimAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const now = Date.now();
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const cachedAt = Number(response?.headers.get(CACHED_AT_HEADER) ?? 0);
    if (isStale(cachedAt, now)) await cache.delete(request);
  }
}
