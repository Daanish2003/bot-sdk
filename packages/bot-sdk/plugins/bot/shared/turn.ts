import { z } from "zod";

/** A Message of a Bot's Conversation: its text, never the Bot's private transcript. */
export const botMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.date(),
});

export type BotMessage = z.infer<typeof botMessageSchema>;

/** How a Turn ended. */
export const turnStatusSchema = z.enum(["complete", "error", "stopped"]);

export type TurnStatus = z.infer<typeof turnStatusSchema>;

/** A Turn's status as the server holds it: `running` until it ends. */
export type BotTurnStatus = TurnStatus | "running";

/** What `bot.send` streams: each Message as it's saved, then how the Turn ended. */
export const botSendEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: botMessageSchema }),
  z.object({ type: z.literal("turnEnded"), status: turnStatusSchema }),
]);

export type BotSendEvent = z.infer<typeof botSendEventSchema>;
