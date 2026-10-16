import type { Messages } from "../../core/shared/i18n";

/** A German Host dictionary for the keys the tests check, in the shape a Host would write. */
export const germanMessages: Partial<Messages> = {
  "time.justNow": "gerade eben",
  "time.minutesAgo": ({ count }) => `vor ${count} Min.`,
  "time.hoursAgo": ({ count }) => `vor ${count} Std.`,
  "time.daysAgo": ({ count }) => `vor ${count} Tg.`,
  "time.today": "Heute",
  "time.yesterday": "Gestern",
  "time.previous7Days": "Letzte 7 Tage",
  "time.previous30Days": "Letzte 30 Tage",
};
