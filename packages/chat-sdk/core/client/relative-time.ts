import type { I18n } from "../shared/i18n";

/** A short relative time for the Conversation panel: "just now", "5m ago", …, then "Sep 20". */
export function relativeTime({ t, locale }: I18n, at: Date, now = new Date()) {
  const seconds = (now.getTime() - at.getTime()) / 1000;
  if (seconds < 60) return t("time.justNow");
  if (seconds < 3600) return t("time.minutesAgo", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("time.hoursAgo", { count: Math.floor(seconds / 3600) });
  if (seconds < 7 * 86400) return t("time.daysAgo", { count: Math.floor(seconds / 86400) });
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
}
