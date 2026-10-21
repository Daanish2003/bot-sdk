import { z } from "zod";

/** How a Demonstration stands (spec #713). */
export const demonstrationStateSchema = z.enum([
  "recording",
  "paused",
  "drafting",
  "saved",
  "cancelled",
  "failed",
]);

export type DemonstrationState = z.infer<typeof demonstrationStateSchema>;

/** Whether a Demonstration still holds its Screen: while it records or is paused. */
export const isLiveDemonstration = (state: DemonstrationState) =>
  state === "recording" || state === "paused";

/**
 * The Show me card part of the Message `watch_user` posts (spec #713): the Demonstration, its goal,
 * how it stands, when it started and ended (ISO), and how many steps it captured, which the closed
 * divider shows. Each change of state rewrites it. The live link is never stored.
 */
export const demonstrationCardSchema = z.object({
  type: z.literal("demonstration"),
  demonstrationId: z.string(),
  goal: z.string(),
  state: demonstrationStateSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  steps: z.number().int(),
});

export type DemonstrationCard = z.infer<typeof demonstrationCardSchema>;
