/** A tier of a Bot's memory (ADR 0022). */
export type MemoryTier = "profile" | "log" | "notes";

/**
 * One change a Bot's post-turn pass made to its memory files, as the Turn's "Memory updated" chip
 * lists it: a line remembered, changed from old to new, or forgotten, with its tier.
 */
export type BotMemoryChange =
  | { kind: "remembered"; tier: MemoryTier; text: string }
  | { kind: "changed"; tier: MemoryTier; from: string; text: string }
  | { kind: "forgot"; tier: MemoryTier; text: string };
