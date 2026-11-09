import type { CallLine } from "../shared/contract";

/*
 * A Call's transcript as a thread message's text (ticket #1384): one line per thing said, under who
 * said it, which is how a Turn reads it. What each says is put on one line, so the owner's view can
 * read the lines back.
 */

const labels = { caller: "Caller: ", agent: "Agent: " } as const;

/** The thread message text of `lines`; what was only silence is left out. */
export const transcriptText = (lines: readonly CallLine[]) =>
  lines
    .map(({ role, text }) => ({ role, said: text.replaceAll(/\s+/g, " ").trim() }))
    .filter(({ said }) => said !== "")
    .map(({ role, said }) => `${labels[role]}${said}`)
    .join("\n");

/** `transcriptText` read back into its lines. */
export function transcriptLines(text: string): CallLine[] {
  if (text === "") return [];
  return text.split("\n").map((line) => {
    const role = line.startsWith(labels.caller) ? "caller" : "agent";
    return { role, text: line.slice(labels[role].length) };
  });
}
