/**
 * How much of each end of a command's stdout or stderr the adapter keeps: 1 MiB characters. A
 * longer stream's middle is left out, so a command that prints for a minute can't exhaust memory,
 * and the tools' spill file still holds far more than the 10,000 characters that spill it.
 */
export const keptEndCharacters = 1024 * 1024;

/**
 * One stream of a running command, collected chunk by chunk: its first and last
 * `keptEndCharacters`, and a count of what it left out between them. It holds at most three times
 * that, since the tail is trimmed only once it doubles.
 */
export function boundedOutput() {
  let head = "";
  let tail = "";
  let leftOut = 0;
  return {
    add(chunk: string) {
      const room = keptEndCharacters - head.length;
      if (room > 0) {
        const cut = pairSafeEnd(chunk, room);
        head += chunk.slice(0, cut);
        chunk = chunk.slice(cut);
      }
      if (!chunk) return;
      tail += chunk;
      if (tail.length > 2 * keptEndCharacters) {
        const start = pairSafeStart(tail, tail.length - keptEndCharacters);
        leftOut += start;
        tail = tail.slice(start);
      }
    },
    /** The characters held now. */
    held: () => head.length + tail.length,
    /** The stream as kept: whole, or both ends around a note of how much was left out. */
    text() {
      const extra = pairSafeStart(tail, Math.max(0, tail.length - keptEndCharacters));
      if (leftOut + extra === 0) return head + tail;
      return `${head}\n[... ${leftOut + extra} characters left out by the computer ...]\n${tail.slice(extra)}`;
    },
  };
}

/** `end`, or one less when it would split a surrogate pair (the halves of one character). */
function pairSafeEnd(text: string, end: number): number {
  return end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

/** `start`, or one more when it would split a surrogate pair. */
function pairSafeStart(text: string, start: number): number {
  return start > 0 && start < text.length && isHighSurrogate(text.charCodeAt(start - 1))
    ? start + 1
    : start;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
