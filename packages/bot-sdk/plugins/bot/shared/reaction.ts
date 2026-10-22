import { z } from "zod";

/** The longest emoji in characters: room for a flag or a skin tone, not for a sentence. */
export const maxEmojiLength = 16;

/** One emoji, as the user or the Bot picked it. */
export const emojiSchema = z
  .string()
  .max(maxEmojiLength)
  .regex(/\p{Extended_Pictographic}/u, { error: "Not an emoji" });

/** One reaction: the emoji and when it was put on. */
export const reactionSchema = z.object({ emoji: z.string(), at: z.date() });

/** The emojis a Message can carry: at most one from the user and one from the Bot (spec #761). */
export type Reactions = { user?: Reaction; bot?: Reaction };

export type Reaction = z.infer<typeof reactionSchema>;

/** The emojis the hover bar offers. */
export const reactionEmojis = ["👍", "❤️", "😂", "🎉", "😮", "🙏"] as const;

/** A reaction as a Message stores it in its parts envelope: `at` is an ISO string. */
export const storedReactionsSchema = z.object({
  user: z.object({ emoji: z.string(), at: z.iso.datetime() }).optional(),
  bot: z.object({ emoji: z.string(), at: z.iso.datetime() }).optional(),
});
