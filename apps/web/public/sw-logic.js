// The pure decisions of the service worker (public/sw.js loads this with importScripts, and the
// unit tests load it too). Kept free of `self` and `caches` so it runs under Node as well.
(function (root) {
  const ASSET_PREFIX = "/assets/";
  // A cached asset older than this is dropped on activate. A tab from an older version can still
  // load its chunks until then.
  const ASSET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  // The chat's `basePath` (/api/chat) and auth (/api/auth) are never served from a cache, so
  // their requests go straight to the network.
  function isNeverHandled(pathname) {
    return pathname === "/api" || pathname.startsWith("/api/");
  }

  /**
   * What the worker does with a request: "navigate" (network first, offline page on failure),
   * "asset" (cache first), or "bypass" (the browser's own network, no respondWith).
   */
  function routeOf(request, selfOrigin) {
    if (request.method !== "GET") return "bypass";
    const url = new URL(request.url);
    if (url.origin !== selfOrigin) return "bypass";
    if (isNeverHandled(url.pathname)) return "bypass";
    if (request.mode === "navigate") return "navigate";
    if (url.pathname.startsWith(ASSET_PREFIX)) return "asset";
    return "bypass";
  }

  /** True when a cached entry was stored before the age limit (a missing stamp counts as old). */
  function isStale(cachedAt, now) {
    return cachedAt < now - ASSET_MAX_AGE_MS;
  }

  root.swLogic = { routeOf, isStale, ASSET_MAX_AGE_MS };
})(typeof self !== "undefined" ? self : globalThis);
