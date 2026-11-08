/*
 * How an SMS is counted. A text in the GSM-7 alphabet fits 160 characters in one segment, or 153 in
 * each segment of a longer one; any other character makes the whole text UCS-2, which fits 70, or
 * 67 in each segment of a longer one. The owner chose at most three segments per reply (spec #1174).
 */

/** The most segments one reply may take. */
export const maxSegments = 3;

/** Characters per segment of a multipart GSM-7 text. */
export const gsmSegment = 153;

/** Characters (UTF-16 units) per segment of a multipart UCS-2 text. */
export const ucsSegment = 67;

/** The longest reply in GSM-7 septets, and in UCS-2 units. */
export const gsmLimit = maxSegments * gsmSegment;
export const ucsLimit = maxSegments * ucsSegment;

const basic = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);

/** The GSM-7 extension table: each takes an escape septet before it. */
const extension = new Set("^{}\\[~]|€\f");

/** The septets `text` takes in GSM-7, or null when a character is outside the alphabet. */
function gsmUnits(text: string): number | null {
  let units = 0;
  for (const char of text) {
    if (basic.has(char)) units += 1;
    else if (extension.has(char)) units += 2;
    else return null;
  }
  return units;
}

/** What a text is sent as, and how long it is in that encoding's units. */
export function measure(text: string): { encoding: "gsm7" | "ucs2"; units: number } {
  const units = gsmUnits(text);
  return units === null ? { encoding: "ucs2", units: text.length } : { encoding: "gsm7", units };
}

/** What a cut reply ends with, so the Customer knows there was more. Plain ASCII, in both encodings. */
export const cutMarker = "... (cut)";

/**
 * `text` as it is sent: whole when it fits in three segments, otherwise cut on a word boundary and
 * ending in `cutMarker`.
 */
export function fitSegments(text: string): { text: string; cut: boolean } {
  const { encoding, units } = measure(text);
  const limit = encoding === "gsm7" ? gsmLimit : ucsLimit;
  if (units <= limit) return { text, cut: false };
  const room = limit - cutMarker.length;
  // Walk characters until the room is used, remembering the last word break.
  let used = 0;
  let end = 0;
  let wordEnd = 0;
  for (const char of text) {
    const size = encoding === "gsm7" ? (basic.has(char) ? 1 : 2) : char.length;
    if (used + size > room) break;
    used += size;
    end += char.length;
    if (/\s/.test(char)) wordEnd = end - char.length;
  }
  // A word break in the first half would drop most of the room (a long link, text with no spaces).
  const kept = text.slice(0, wordEnd * 2 >= end ? wordEnd : end).trimEnd();
  return { text: `${kept}${cutMarker}`, cut: true };
}

/** Whether `text` takes no more than three segments in its own encoding. */
function fits(text: string): boolean {
  const { encoding, units } = measure(text);
  return units <= (encoding === "gsm7" ? gsmLimit : ucsLimit);
}

/**
 * `text` followed by `tail` (a control's options) as it is sent: whole when it fits, otherwise the
 * text is cut on a word boundary and ends in `cutMarker`, and the tail stays whole after it. When
 * the tail alone can't fit, the two are cut together, as `fitSegments` does.
 */
export function fitWithTail(text: string, tail: string): string {
  const joined = [text, tail].filter(Boolean).join("\n\n");
  if (fits(joined)) return joined;
  if (!tail) return fitSegments(text).text;
  const build = (length: number) => `${text.slice(0, length).trimEnd()}${cutMarker}\n\n${tail}`;
  if (!fits(build(0))) return fitSegments(joined).text;
  // The longest prefix that still fits: more characters never take fewer units.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(build(middle))) low = middle;
    else high = middle - 1;
  }
  const word = text.slice(0, low).search(/\s\S*$/);
  return build(word * 2 >= low ? word : low);
}
