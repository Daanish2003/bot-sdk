import { z } from "zod";

/** How many Bot-to-Bot handoffs a chain in a Room may take before it waits for the user (spec #1055). */
export const hopLimit = 3;

/**
 * The handoff a Bot's Room Message made (spec #1055): the members it mentioned, by id, and its hop
 * in the chain. A hop past `hopLimit` woke no one: the chain stopped there.
 */
export const handoffSchema = z.object({ to: z.array(z.string()), hops: z.number().int() });

export type Handoff = z.infer<typeof handoffSchema>;

/** A letter, digit or underscore: what may not touch a mention on either side. */
const wordChar = /[\p{L}\p{N}_]/u;

/**
 * The Bots a Room Message mentions (spec #1055), by id, each once, in the order first mentioned: `@`
 * followed by a member's full name, case-insensitive, the longest name matched first so names with
 * spaces work. An `@` inside a word (an email address), or one that matches no member, is plain
 * text, as is a name that runs on into a longer word.
 */
export function mentionedMembers(
  text: string,
  members: readonly { botId: string; name: string }[],
): string[] {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && wordChar.test(text[at - 1]!)) continue;
    const match = byLength.find(({ name }) => {
      // Compared on the original text, since lower-casing can change a string's length.
      const typed = text.slice(at + 1, at + 1 + name.length);
      if (!name || typed.toLowerCase() !== name.toLowerCase()) return false;
      const after = text[at + 1 + name.length];
      return after === undefined || !wordChar.test(after);
    });
    if (match && !found.includes(match.botId)) found.push(match.botId);
  }
  return found;
}
