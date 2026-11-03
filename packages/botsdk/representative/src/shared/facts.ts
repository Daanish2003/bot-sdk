/*
 * What a Published fact's value may be, by its type (ticket #1258). Each checker returns the value
 * in the form that is stored and, later, put into a reply by code, or null when the value doesn't
 * fit its type. No model reads a fact to reword it.
 */

export const factTypes = ["text", "money", "hours", "phone", "url"] as const;
export type FactType = (typeof factTypes)[number];

export const maxFactValueLength = 2_000;

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayPattern = days.join("|");
const segmentPattern = new RegExp(
  `^(${dayPattern})(?:-(${dayPattern}))?\\s+(?:closed|([01]\\d|2[0-3]):([0-5]\\d)-([01]\\d|2[0-3]):([0-5]\\d))$`,
);

/** `45 USD` or `19.99 EUR`: an amount of up to two decimals, then a three-letter currency code. */
function money(value: string) {
  const match = /^(\d{1,12}(?:\.\d{1,2})?)\s*([A-Za-z]{3})$/.exec(value);
  return match ? `${match[1]} ${match[2]!.toUpperCase()}` : null;
}

/** `Mon-Fri 09:00-17:00; Sat closed`: day or day range, then an opening span or `closed`. */
function hours(value: string) {
  const segments = value.split(";").map((segment) => segment.trim().replace(/\s+/g, " "));
  for (const segment of segments) {
    const match = segmentPattern.exec(segment);
    if (!match) return null;
    const [, from, to, openH, openM, closeH, closeM] = match;
    if (to && days.indexOf(to) < days.indexOf(from!)) return null;
    if (openH !== undefined && `${openH}${openM}` >= `${closeH}${closeM}`) return null;
  }
  return segments.join("; ");
}

/** An international number: a plus and 7 to 15 digits, written with or without spaces, dots, dashes or brackets. */
function phone(value: string) {
  const digits = value.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

/** A web address that opens with http or https. */
function url(value: string) {
  if (value.length > 2_048) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

const checkers: Record<FactType, (value: string) => string | null> = {
  text: (value) => (value === "" ? null : value),
  money,
  hours,
  phone,
  url,
};

/** `value` in its stored form, or null when it doesn't fit `type`. */
export function checkFactValue(type: FactType, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > maxFactValueLength) return null;
  return checkers[type](trimmed);
}

/** Whether a fact with these valid dates is in effect at `now`: from its start, up to but not including its end. */
export function isInEffect(
  fact: { validFrom: Date | null; validUntil: Date | null },
  now: Date,
): boolean {
  return (
    (fact.validFrom === null || fact.validFrom <= now) &&
    (fact.validUntil === null || now < fact.validUntil)
  );
}
