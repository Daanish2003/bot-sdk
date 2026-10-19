/** The zone a Message without one is read in. */
export const defaultTimeZone = "UTC";

const formatters = new WeakMap<Intl.DateTimeFormatOptions, Map<string, Intl.DateTimeFormat>>();

/**
 * The `en-GB` formatter of `options` in `zone`, built once per pair: building one is slow, and
 * Routines and notices format on every fire and Turn. `options` must be a module constant, the
 * cache's key. Throws for a zone the runtime doesn't know, as `Intl.DateTimeFormat` does.
 */
export function formatterIn(
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let byZone = formatters.get(options);
  if (!byZone) formatters.set(options, (byZone = new Map()));
  let formatter = byZone.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone });
    byZone.set(zone, formatter);
  }
  return formatter;
}

const zoneOnly: Intl.DateTimeFormatOptions = {};

/** Whether `zone` is an IANA time zone the runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    formatterIn(zone, zoneOnly);
    return true;
  } catch {
    return false;
  }
}

/** `zone`, or UTC when it's absent or this runtime doesn't know it, so a stored zone stops nothing. */
export function knownZone(zone: string | undefined): string {
  return zone !== undefined && isTimeZone(zone) ? zone : defaultTimeZone;
}

const noticeTime: Intl.DateTimeFormatOptions = {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * The note that opens the Turn's newest input (slide 31: "the time, short notes on anything that
 * changed, then your message"): `at` as the clock reads in `stored`, so "now" and "tomorrow at 9"
 * mean the user's.
 */
export function timeNotice(at: Date, stored: string | undefined): string {
  const zone = knownZone(stored);
  return `[Current time: ${formatterIn(zone, noticeTime).format(at)} (${zone})]`;
}
