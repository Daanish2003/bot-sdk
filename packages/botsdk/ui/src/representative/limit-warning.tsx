import { useQuota } from "@botsdk/react/models/quota";
import { useI18n } from "@botsdk/react/provider";
import { TriangleAlertIcon } from "lucide-react";

/** How used a limit is when the owner starts to hear about it. */
const warnAtPercent = 80;

function Warning({ children }: { children: string }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      {children}
    </p>
  );
}

/**
 * Tells the owner, on the Representative pages, that a limit is near or reached (ticket #1309): the
 * Quota, and on a Representative's own page its monthly spending cap too (ticket #1310).
 */
export function LimitWarning({ monthUsedPercent = 0 }: { monthUsedPercent?: number }) {
  const { t } = useI18n();
  const usedPercent = useQuota().data?.usedPercent ?? 0;
  return (
    <>
      {usedPercent >= warnAtPercent && (
        <Warning>{t("representative.limitWarning", { percent: usedPercent })}</Warning>
      )}
      {monthUsedPercent >= warnAtPercent && (
        <Warning>{t("representative.monthWarning", { percent: monthUsedPercent })}</Warning>
      )}
    </>
  );
}
