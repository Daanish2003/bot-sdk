import { isTimeZone } from "../shared/contract";

/*
 * Quiet hours for the Outbound gate (ticket #1303): whole hours in a time zone, from `startHour` to
 * `endHour`, wrapping past midnight when the end is earlier. Equal hours are no quiet period.
 */

export type QuietPeriod = { startHour: number; endHour: number };

const minuteMs = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The hour (0 to 23) it is at `at` in `timeZone`. */
function hourIn(at: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric" });
    formatters.set(timeZone, formatter);
  }
  return Number(formatter.format(at)) % 24;
}

/** `zone` if it names a time zone, otherwise `fallback`. */
export const zoneOr = (zone: string | null | undefined, fallback: string) =>
  zone && isTimeZone(zone) ? zone : fallback;

export function isQuiet(at: Date, timeZone: string, { startHour, endHour }: QuietPeriod) {
  const hour = hourIn(at, timeZone);
  if (startHour === endHour) return false;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

/** The first whole minute after `at` that isn't quiet: the quiet period's end, wherever a time change put it. */
export function quietEndsAt(at: Date, timeZone: string, period: QuietPeriod) {
  let candidate = new Date(Math.floor(at.getTime() / minuteMs) * minuteMs);
  // At most a day: a period that never ends can't be (equal hours aren't quiet).
  for (let step = 0; step <= 24 * 60 && isQuiet(candidate, timeZone, period); step++) {
    candidate = new Date(candidate.getTime() + minuteMs);
  }
  return candidate;
}
