/**
 * Set when the page reloads for a failed chunk, and cleared once a page has stayed up for a while.
 * So a broken build reloads once, and a second failure right after that shows the error.
 */
const chunkReloadKey = "ai-chat:chunk-reloaded";
const healthyAfterMs = 10_000;

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
    if (!markChunkReload()) return;
    window.location.reload();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  // A page that stays up this long has recovered, so a later failure may reload it again.
  const clear = window.setTimeout(() => clearChunkReload(), healthyAfterMs);
  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.clearTimeout(clear);
  };
}

/** True when the page may reload now: it hasn't already reloaded for a chunk and not yet recovered. */
function markChunkReload(): boolean {
  try {
    if (sessionStorage.getItem(chunkReloadKey) !== null) return false;
    sessionStorage.setItem(chunkReloadKey, "1");
    return true;
  } catch {
    // Storage is blocked and the loop guard can't be kept: don't reload at all.
    return false;
  }
}

function clearChunkReload() {
  try {
    sessionStorage.removeItem(chunkReloadKey);
  } catch {
    // Nothing was stored.
  }
}
