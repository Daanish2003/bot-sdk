/** Remembers when the page last reloaded for a failed chunk, so a broken build can't reload forever. */
const chunkReloadKey = "ai-chat:chunk-reload-at";
const chunkReloadWindowMs = 30_000;

/**
 * Registers `/sw.js` (public/sw.js). Production builds only: in dev nothing stale is cached.
 * Returns a cleanup that removes the chunk-failure listener.
 */
export function registerServiceWorker(): () => void {
  if (!import.meta.env.PROD) return () => {};

  if ("serviceWorker" in navigator) {
    // A failed registration only means the app isn't installable or offline; it still works.
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }

  // A tab from an older deploy can ask for a chunk that no longer exists. Vite reports that as
  // `vite:preloadError`; reload once so the tab picks up the new build.
  const onPreloadError = (event: Event) => {
    event.preventDefault();
    if (!reloadForChunk()) return;
    window.location.reload();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}

/** True when the page may reload now: it hasn't reloaded for a chunk in the last 30 seconds. */
function reloadForChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(chunkReloadKey) ?? 0);
    if (Date.now() - last < chunkReloadWindowMs) return false;
    sessionStorage.setItem(chunkReloadKey, String(Date.now()));
    return true;
  } catch {
    // Storage is blocked and the loop guard can't be kept: don't reload at all.
    return false;
  }
}
