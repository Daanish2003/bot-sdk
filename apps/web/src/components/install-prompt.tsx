import { useI18n } from "@ai-chat/chat-sdk/client";
import { Button } from "@ai-chat/ui/components/button";
import { useEffect, useState } from "react";

/** Where this browser remembers that the user dismissed the install row. */
const dismissedKey = "ai-chat:install-dismissed";

/** Chromium's `beforeinstallprompt`, which can be shown once. */
type InstallEvent = Event & { prompt: () => Promise<unknown> };

function isInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS has no install prompt: its Share sheet has Add to Home Screen. iPadOS reports as a Mac. */
function isIos() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isDismissed() {
  try {
    return localStorage.getItem(dismissedKey) !== null;
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    localStorage.setItem(dismissedKey, "1");
  } catch {
    // Not remembered: the row comes back on the next load.
  }
}

/**
 * The install row for the drawer's bottom (`AppShell`'s `installPrompt` slot). On Chromium it
 * shows Install once the browser offers the prompt; on iOS it shows the Share steps. It renders
 * nothing when the app is already installed or the user dismissed it.
 */
export function InstallPrompt() {
  const { t } = useI18n();
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Set after mount, so the server's render and the first client render match (both empty).
  useEffect(() => {
    if (isInstalled() || isDismissed()) {
      setDismissed(true);
      return;
    }
    if (isIos()) {
      setShowIosSteps(true);
      return;
    }
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (dismissed || (!installEvent && !showIosSteps)) return null;

  const install = async () => {
    if (!installEvent) return;
    // A prompt is good for one showing; the user's choice is the browser's to remember.
    setInstallEvent(null);
    await installEvent.prompt();
  };

  const dismiss = () => {
    rememberDismissed();
    setDismissed(true);
  };

  return (
    <section
      aria-label={t("shell.installTitle")}
      className="flex flex-col gap-2 border-t p-3 text-sm max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <p className="font-medium">{t("shell.installTitle")}</p>
      {installEvent ? (
        <Button size="sm" onClick={install}>
          {t("shell.install")}
        </Button>
      ) : (
        <p className="text-muted-foreground">{t("shell.installIosSteps")}</p>
      )}
      <Button variant="ghost" size="sm" onClick={dismiss}>
        {t("shell.installNotNow")}
      </Button>
    </section>
  );
}
