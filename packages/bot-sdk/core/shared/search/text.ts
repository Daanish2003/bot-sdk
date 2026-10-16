/** The shortest query `search.query` accepts, and the palette sends. */
export const minSearchLength = 2;

/** Escapes `\`, `%` and `_` so user input matches literally inside a `LIKE`/`ILIKE` pattern. */
export function escapeLike(input: string) {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** How much of a Message a search hit shows. */
export const snippetLength = 160;

export type Snippet = {
  /** One line of plain text; `…` marks where it was cut. Never markdown or HTML. */
  text: string;
  /** Where the first match sits in `text`; empty when it wasn't found. */
  match: { start: number; end: number };
};

/**
 * About `length` characters of `text` around the first case-insensitive match of `q`, with
 * whitespace collapsed to single spaces.
 */
export function snippetAround(text: string, q: string, length = snippetLength): Snippet {
  const line = text.replace(/\s+/g, " ").trim();
  const needle = q.replace(/\s+/g, " ").trim();
  // A case-insensitive regex keeps offsets into `line`; lower-casing can change string lengths.
  const found = needle
    ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(line)
    : null;
  const matchStart = found?.index ?? 0;
  const matchLength = found?.[0].length ?? 0;

  const room = Math.max(0, length - matchLength);
  let start = Math.max(0, matchStart - Math.floor(room / 2));
  const end = Math.min(line.length, start + Math.max(length, matchLength));
  start = Math.max(0, end - Math.max(length, matchLength));

  const lead = start > 0 ? "…" : "";
  const tail = end < line.length ? "…" : "";
  const offset = lead.length - start;
  return {
    text: `${lead}${line.slice(start, end)}${tail}`,
    match: found
      ? { start: matchStart + offset, end: matchStart + matchLength + offset }
      : { start: 0, end: 0 },
  };
}
