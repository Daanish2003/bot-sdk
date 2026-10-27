import type { RoutineDay, RoutineSchedule } from "@botsdk/client/bot/routine";

import { formatterIn, knownZone } from "../conversation";

const minuteMs = 60_000;
const dayMs = 86_400_000;

/** `Date.getUTCDay()`'s order. */
const dayNames: readonly RoutineDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const wallClock: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

/** What the clock in `zone` reads at `at`, as the UTC instant with the same reading, in ms. */
function wallClockOf(at: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterIn(zone, wallClock).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
}

/**
 * The first instant at which the clock in `zone` reads `wall` (a reading as UTC ms), or `undefined`
 * when it never does (a time skipped by a change to summer time). A reading that happens twice (a
 * change back) is its first occurrence.
 */
function firstInstantOf(wall: number, zone: string): number | undefined {
  // The zone's offsets a day either side cover both sides of any change near `wall`.
  const offsets = [wall - dayMs, wall + dayMs].map((at) => wallClockOf(at, zone) - at);
  const matches = offsets
    .map((offset) => wall - offset)
    .filter((at) => wallClockOf(at, zone) === wall)
    .sort((a, b) => a - b);
  return matches[0];
}

/**
 * The first slot of `schedule` after `after` (#536): `at` on one of its days, wall-clock time in
 * `zone`. A time that doesn't exist that day fires at the next valid minute; a time that happens
 * twice fires at its first occurrence.
 */
export function nextSlot(schedule: RoutineSchedule, zone: string, after: Date): Date {
  const known = knownZone(zone);
  const [hours, minutes] = schedule.at.split(":").map(Number);
  const today = Math.floor(wallClockOf(after.getTime(), known) / dayMs) * dayMs;
  // Today and the next seven days hold every day of the week once more.
  for (let offset = 0; offset <= 7; offset++) {
    const day = today + offset * dayMs;
    if (!schedule.days.includes(dayNames[new Date(day).getUTCDay()]!)) continue;
    let wall = day + (hours! * 60 + minutes!) * minuteMs;
    let at = firstInstantOf(wall, known);
    // Skipped by a change to summer time: the next minute the clock does read.
    for (let step = 0; at === undefined && step < 24 * 60; step++) {
      wall += minuteMs;
      at = firstInstantOf(wall, known);
    }
    if (at !== undefined && at > after.getTime()) return new Date(at);
  }
  throw new Error(`Schedule ${JSON.stringify(schedule)} has no slot after ${after.toISOString()}`);
}
