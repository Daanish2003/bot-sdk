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
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (!chunk) return;
      tail += chunk;
      if (tail.length > 2 * keptEndCharacters) {
        leftOut += tail.length - keptEndCharacters;
        tail = tail.slice(-keptEndCharacters);
      }
    },
    /** The characters held now. */
    held: () => head.length + tail.length,
    /** The stream as kept: whole, or both ends around a note of how much was left out. */
    text() {
      const extra = Math.max(0, tail.length - keptEndCharacters);
      if (leftOut + extra === 0) return head + tail;
      return `${head}\n[... ${leftOut + extra} characters left out by the computer ...]\n${tail.slice(extra)}`;
    },
  };
}
