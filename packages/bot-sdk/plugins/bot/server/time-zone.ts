/** The zone a Message without one is read in. */
export const defaultTimeZone = "UTC";

/** Whether `zone` is an IANA time zone the runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The note that opens the Turn's newest input (slide 31: "the time, short notes on anything that
 * changed, then your message"): `at` as the clock reads in `zone`, so "now" and "tomorrow at 9" mean
 * the user's.
 */
export function timeNotice(at: Date, zone: string = defaultTimeZone): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return `[Current time: ${time} (${zone})]`;
}
