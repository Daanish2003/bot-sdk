import { useI18n } from "@ai-chat/chat-sdk/client";
import { Button } from "@ai-chat/ui/components/button";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getInstallPrompt, subscribeInstallPrompt, takeInstallPrompt } from "@/lib/install-prompt";

/** Where this browser remembers that the user dismissed the install row. */
const dismissedKey = "ai-chat:install-dismissed";

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
 * shows Install once the browser offers the prompt (captured by `captureInstallPrompt` at the
 * root); on iOS it shows the Share steps. It renders nothing when the app is already installed or
 * the user dismissed it.
 */
export function InstallPrompt() {
  const { t } = useI18n();
  // Null on the server and the first client render, so the two match.
  const installEvent = useSyncExternalStore(subscribeInstallPrompt, getInstallPrompt, () => null);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Set after mount, so the server's render and the first client render match (both empty).
  useEffect(() => {
    if (isInstalled() || isDismissed()) {
      setDismissed(true);
      return;
    }
    setShowIosSteps(isIos());
  }, []);

  if (dismissed || (!installEvent && !showIosSteps)) return null;

  const install = async () => {
    const event = takeInstallPrompt();
    await event?.prompt();
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
