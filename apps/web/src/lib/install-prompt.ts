/** Chromium's `beforeinstallprompt`, which can be shown once. */
export type InstallEvent = Event & { prompt: () => Promise<unknown> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();

function setDeferred(event: InstallEvent | null) {
  deferred = event;
  for (const listen of listeners) listen();
}

/**
 * Keeps Chromium's install prompt from the moment the root mounts. The browser fires
 * `beforeinstallprompt` once, early, so the install row (which mounts later) would miss it.
 */
export function captureInstallPrompt(): () => void {
  const onBeforeInstall = (event: Event) => {
    event.preventDefault();
    setDeferred(event as InstallEvent);
  };
  const onInstalled = () => setDeferred(null);
  window.addEventListener("beforeinstallprompt", onBeforeInstall);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

/** Takes the captured prompt. A prompt is good for one showing. */
export function takeInstallPrompt(): InstallEvent | null {
  const event = deferred;
  setDeferred(null);
  return event;
}

export function subscribeInstallPrompt(listen: () => void): () => void {
  listeners.add(listen);
  return () => listeners.delete(listen);
}

export function getInstallPrompt(): InstallEvent | null {
  return deferred;
}
