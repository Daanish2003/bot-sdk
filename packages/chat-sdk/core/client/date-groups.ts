const monthYear = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

const msPerDay = 86_400_000;

/** The local calendar day of `date` as a whole number, so DST shifts don't count as days. */
function calendarDay(date: Date) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / msPerDay);
}

/**
 * The group a time falls in, measured in the viewer's local calendar days from `now`: "Today",
 * "Yesterday", "Previous 7 days", "Previous 30 days", then the month and year.
 */
export function dateGroupLabel(at: Date, now = new Date()) {
  const days = calendarDay(now) - calendarDay(at);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return monthYear.format(at);
}

/**
 * Splits rows, already in order (newest first), into runs that share a date group. Each run keeps
 * the rows' order, so the groups read top to bottom like the list.
 */
export function groupByDate<T>(rows: T[], dateOf: (row: T) => Date, now = new Date()) {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = dateGroupLabel(dateOf(row), now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}
