/** A user's Quota as `quota.read` answers it: the used percentage, never money (ADR 0007). */
export type QuotaRead = { usedPercent: number; window: "day" | "month"; resetsAt: Date | string };

/** Whether the Quota is spent. The server refuses a Host Model's Run from then on (HTTP 402). */
export function quotaExceeded(quota: Pick<QuotaRead, "usedPercent"> | null | undefined): boolean {
  return (quota?.usedPercent ?? 0) >= 100;
}

/** Whether the spent Quota blocks a Model: only a Host Model is, the user's own never is. */
export function quotaBlocksModel(
  model: { onHostCredentials: boolean } | undefined,
  quota: Pick<QuotaRead, "usedPercent"> | null | undefined,
): boolean {
  return model?.onHostCredentials === true && quotaExceeded(quota);
}

import { dateFormat } from "../../../core/client/intl";

/** When a Quota window resets, in the viewer's time zone and locale: "Oct 11, 12:00 AM". */
export function quotaResetsAt(at: Date | string, locale: string): string {
  return dateFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}
