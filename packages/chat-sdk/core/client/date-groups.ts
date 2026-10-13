import type { I18n } from "../shared/i18n";
import { dateFormat } from "./intl";

const msPerDay = 86_400_000;

/** The local calendar day of `date` as a whole number, so DST shifts don't count as days. */
function calendarDay(date: Date) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / msPerDay);
}

/**
 * The group a time falls in, measured in the viewer's local calendar days from `now`: "Today",
 * "Yesterday", "Previous 7 days", "Previous 30 days", then the month and year.
 */
export function dateGroupLabel({ t, locale }: I18n, at: Date, now = new Date()) {
  const days = calendarDay(now) - calendarDay(at);
  if (days <= 0) return t("time.today");
  if (days === 1) return t("time.yesterday");
  if (days <= 7) return t("time.previous7Days");
  if (days <= 30) return t("time.previous30Days");
  return dateFormat(locale, { month: "long", year: "numeric" }).format(at);
}

/**
 * Splits rows, already in order (newest first), into runs that share a date group. Each run keeps
 * the rows' order, so the groups read top to bottom like the list.
 */
export function groupByDate<T>(rows: T[], dateOf: (row: T) => Date, i18n: I18n, now = new Date()) {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = dateGroupLabel(i18n, dateOf(row), now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}
