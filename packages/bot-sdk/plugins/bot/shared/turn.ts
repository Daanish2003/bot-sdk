import { z } from "zod";

import type { BotMemoryChange } from "../../memory/shared/changes";
import type { BotKnowledgeChange } from "../../knowledge/shared/changes";
import type { BotSkillChange } from "../../skills/shared/changes";
import { richControlSchema } from "./rich-control";

/**
 * A Message of a Bot's Conversation: its text, never the Bot's private transcript, and at most one
 * Rich control: a Computer-use Helper's hand-off Message has its Computer card, a Message that
 * asks for a Secret has its request, and the Message `watch_user` posts has its Show me card.
 */
export const botMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.date(),
  control: richControlSchema.optional(),
  /** The Channel a user's Message came in on, when not web: shown as "via email". */
  channel: z.literal("email").optional(),
});

export type BotMessage = z.infer<typeof botMessageSchema>;

/** How a Turn ended. */
export const turnStatusSchema = z.enum(["complete", "error", "stopped"]);

export type TurnStatus = z.infer<typeof turnStatusSchema>;

/** A Turn's status as the server holds it: `running` until it ends. */
export type BotTurnStatus = TurnStatus | "running";

/**
 * One Trigger a Turn took, as the Conversation read shows it: where it came from, the Routine's
 * name when a Routine fired (otherwise `null`), and its time: a scheduled fire's slot, otherwise
 * when it was received.
 */
export type BotTurnTrigger = {
  source: "user" | "routine" | "check_in" | "helper";
  channel: "web" | "schedule" | "webhook" | "helper" | "email";
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
  /** A model call of the Turn (`turn`), or its mid-Turn summary call (`summary`), which hashes nothing. */
  kind: "turn" | "summary";
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
  /** The Skills the Turn saved or updated (spec #713), or null when it wrote none. */
  skillChanges: BotSkillChange[] | null;
  /** The files the Turn saved to Knowledge (spec #737), or null when it saved none. */
  knowledgeChanges: BotKnowledgeChange[] | null;
  /** Its Steps, oldest first, for the cache chip (#675). */
  steps: BotTurnStep[];
};

/**
 * A Summary of the Bot's Conversation (#676), for its card in the thread: written while the user
 * was away or mid-Turn, the model's account, and the Bot's last Messages to the user it kept word
 * for word, oldest first.
 */
export type BotSummary = {
  id: string;
  kind: "away" | "mid_turn";
  at: Date;
  text: string;
  kept: BotMessage[];
};

/** A call that warmed a Bot's cache (#677), for the muted line in its thread. */
export type BotWarming = { id: string; at: Date; costMicros: number };
