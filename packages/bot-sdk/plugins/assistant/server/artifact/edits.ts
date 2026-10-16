/** One targeted change: `old` must occur exactly once in the content, and becomes `new`. */
export type Edit = { old: string; new: string };

/**
 * Applies the edits in order, each to the result of the one before, so a later edit sees the
 * earlier ones (as a reader would). Any edit with no match or several makes the whole set fail,
 * and the error names it (1-based), so the Model can fix that edit.
 */
export function applyEdits(
  content: string,
  edits: Edit[],
): { content: string } | { error: string } {
  let next = content;
  for (const [index, edit] of edits.entries()) {
    const matches = occurrencesOf(next, edit.old);
    if (matches === 0) return { error: `Edit ${index + 1}: No match` };
    if (matches > 1) return { error: `Edit ${index + 1}: Found ${matches} matches` };
    next = next.replace(edit.old, () => edit.new);
  }
  return { content: next };
}

/** How many times `needle` occurs in `haystack`, not counting overlaps. */
function occurrencesOf(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count++;
  }
  return count;
}
