import { z } from "zod";

import type { BotMemoryChange } from "../../memory/shared/changes";
import { computerCardSchema } from "./helper";

/**
 * A Message of a Bot's Conversation: its text, never the Bot's private transcript. A Computer-use
 * Helper's hand-off Message also has its Computer card.
 */
export const botMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.date(),
  computer: computerCardSchema.optional(),
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

/**
 * One Trigger a Turn took, as the Conversation read shows it: where it came from, the Routine's
 * name when a Routine fired (otherwise `null`), and its time: a scheduled fire's slot, otherwise
 * when it was received.
 */
export type BotTurnTrigger = {
  source: "user" | "routine" | "check_in" | "helper";
  channel: "web" | "schedule" | "webhook" | "helper";
  routineName: string | null;
  at: Date;
};

/** One section of the prompt a Step sent: its size, hash, and the hash it had in the Step before. */
export type BotStepSection = {
  name: string;
  /** An estimate, to size the prompt bar. */
  tokens: number;
  hash: string;
  /** The Step before's hash of this section, when this one is flagged as changed. */
  was?: string;
};

/**
 * One Step of a Turn (one model call): what it sent, what the Provider's cache did with it, and
 * what it cost (#675). `changed` names the first section that differs from the Step before: a
 * `bug` (the Prompt start was the same) or `expected` (a new Prompt start).
 */
export type BotTurnStep = {
  id: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  sections: BotStepSection[];
  changed: { section: string; kind: "bug" | "expected" } | null;
};

/** A Turn's provenance (#539): the Triggers it took, and whether it sent the user anything. */
export type BotTurnProvenance = {
  id: string;
  status: BotTurnStatus;
  startedAt: Date;
  endedAt: Date | null;
  sent: boolean;
  triggers: BotTurnTrigger[];
  /** What the Turn's post-turn memory pass changed (ADR 0022), or null when it changed nothing. */
  memoryChanges: BotMemoryChange[] | null;
  /** Its Steps, oldest first, for the cache chip (#675). */
  steps: BotTurnStep[];
};
