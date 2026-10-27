/** A user's Knowledge folder on their Computer, shared by all of their Bots (ADR 0025). */
export const knowledgeDirectory = "/home/user/shared/knowledge";

/** The most listing bytes a walk reads; the entries past it are left out. */
export const walkListingBytes = 1024 * 1024;

/**
 * Lists the tree under `$d` in one pass of `find`, without following symlinks. It prints base64 of
 * one NUL-ended entry per folder (`d 0 0 <relative path>`) and file (`f <size> <mtime> <relative
 * path>`), cut at `walkListingBytes` (NUL-ended, so a name with a line break stays one entry),
 * then a line with the bytes all files hold, then one with the whole listing's length. Prints
 * nothing when there is no folder yet.
 */
export const walkScript = [
  `[ -d "$d" ] || exit 0`,
  `l=$(mktemp) && t=$(mktemp) || exit 1`,
  String.raw`find "$d" -mindepth 1 \( -type d -printf 'd 0 0 %P\0' -o -type f -printf 'f %s %T@ %P\0' -fprintf "$t" '%s\n' \) > "$l" 2>/dev/null`,
  `head -c ${walkListingBytes} "$l" | base64 -w0`,
  String.raw`printf '\n'`,
  `awk '{ s += $1 } END { print s + 0 }' "$t"`,
  `wc -c < "$l"`,
  `rm -f "$l" "$t"`,
].join("\n");

/** Prints the mtime and size of the file `$p`, as a walk's stamp; nothing when there is none. */
export const stampScript = String.raw`find "$p" -maxdepth 0 -type f -printf '%T@ %s' 2>/dev/null; true`;
