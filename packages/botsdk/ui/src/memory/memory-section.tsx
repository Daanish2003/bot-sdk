import { Button } from "@/components/ui/button";
import { toast } from "sonner";

import { useMemoryStatus, useRefreshMemoryStatus, useSetMemoryEnabled } from "@botsdk/memory/react";
import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";

/**
 * Settings: the Memory switch, which turns the Bots' memory on and off (ADR 0022). Each Bot's
 * memory is shown and edited on its own page. Render it only when the Host installs the `memory`
 * plugin.
 */
export function MemorySection() {
  const i18n = useI18n();
  const { t } = i18n;
  const status = useMemoryStatus();
  const refreshStatus = useRefreshMemoryStatus();
  const setEnabled = useSetMemoryEnabled({
    onSuccess: refreshStatus,
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });

  if (!status.data) return null;
  const { enabled } = status.data;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("settings.memory")}</h2>
        <p className="text-xs text-muted-foreground">{t("settings.memoryHelp")}</p>
      </div>

      <Button
        role="switch"
        aria-checked={enabled}
        variant="outline"
        size="sm"
        disabled={setEnabled.isPending}
        onClick={() => setEnabled.mutate({ enabled: !enabled })}
      >
        <span
          aria-hidden
          className={
            enabled
              ? "size-2 rounded-full bg-green-500"
              : "size-2 rounded-full bg-muted-foreground/40"
          }
        />
        {t("settings.memoryUse")}
      </Button>

      {!enabled && (
        <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          {t("settings.memoryOffBanner")}
        </p>
      )}
    </section>
  );
}
