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

/**
 * `boundedOutput` that replaces every string of `redact` (longest first) with `***` as chunks
 * arrive, before the ends are cut. It holds back the last few characters of each chunk, since a
 * string may continue in the next one; `text()` releases them.
 */
export function redactedOutput(redact: string[]) {
  const forms = redact.filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
  const hold = Math.max(0, ...forms.map((form) => form.length)) - 1;
  const inner = boundedOutput();
  let pending = "";
  const replaced = (text: string) => forms.reduce((out, form) => out.split(form).join("***"), text);
  return {
    add(chunk: string) {
      pending = replaced(pending + chunk);
      const cut = pairSafeEnd(pending, Math.max(0, pending.length - hold));
      inner.add(pending.slice(0, cut));
      pending = pending.slice(cut);
    },
    held: () => inner.held() + pending.length,
    text() {
      inner.add(pending);
      pending = "";
      return inner.text();
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
