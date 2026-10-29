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

  const NOTIFICATION_ICON = "/icons/icon-192.png";

  /**
   * The notification a push shows (spec #1024): its payload is JSON with the Bot's name (`title`),
   * the Message's first line (`body`), the Conversation's `url` and the Message's `tag`. Every push
   * must show a notification, so a payload it can't read shows a plain one that opens the app.
   */
  function notificationOf(payload) {
    let push;
    try {
      push = JSON.parse(payload);
    } catch {
      push = undefined;
    }
    const readable =
      push !== null &&
      typeof push === "object" &&
      typeof push.title === "string" &&
      typeof push.body === "string" &&
      typeof push.url === "string";
    if (!readable) {
      return {
        title: "New message",
        options: { body: "", icon: NOTIFICATION_ICON, data: { url: "/" } },
      };
    }
    return {
      title: push.title,
      options: {
        body: push.body,
        ...(typeof push.tag === "string" && { tag: push.tag }),
        icon: NOTIFICATION_ICON,
        data: { url: push.url },
      },
    };
  }

  /** The page a click on a notification opens: the URL it names on this origin, else the app. */
  function clickUrlOf(data, selfOrigin) {
    const home = new URL("/", selfOrigin).href;
    if (!data || typeof data.url !== "string") return home;
    try {
      const url = new URL(data.url, selfOrigin);
      return url.origin === selfOrigin ? url.href : home;
    } catch {
      return home;
    }
  }

  root.swLogic = { routeOf, isStale, ASSET_MAX_AGE_MS, notificationOf, clickUrlOf };
})(typeof self !== "undefined" ? self : globalThis);
