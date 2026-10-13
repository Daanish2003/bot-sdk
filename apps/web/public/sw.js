// The service worker for apps/web (hand-written, no build plugin). It caches the app's static
// files and an offline page, and never touches the chat's API, auth or Shared links.
//
// Served from the root so its scope covers the whole app. Registered in production builds only
// (see src/lib/service-worker.ts).

const ASSET_CACHE = "ai-chat-assets";
const OFFLINE_CACHE = "ai-chat-offline";
const OFFLINE_URL = "/offline.html";
const ASSET_PREFIX = "/assets/";
// A cached asset older than this is dropped on activate. A tab from an older version can still
// load its chunks until then.
const ASSET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = "x-cached-at";

// The chat's `basePath` (/api/chat), auth (/api/auth) and the Shared links (/share/*) are never
// served from a cache, so their requests go straight to the network.
function isNeverHandled(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/share" ||
    pathname.startsWith("/share/")
  );
}

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
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverHandled(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithOfflinePage(request));
    return;
  }
  if (url.pathname.startsWith(ASSET_PREFIX)) {
    event.respondWith(cacheFirst(request, event));
  }
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
  const cutoff = Date.now() - ASSET_MAX_AGE_MS;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const cachedAt = Number(response?.headers.get(CACHED_AT_HEADER) ?? 0);
    if (cachedAt < cutoff) await cache.delete(request);
  }
}
