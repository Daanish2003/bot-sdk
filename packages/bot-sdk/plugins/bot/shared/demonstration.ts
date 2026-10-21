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

/** The Demonstration states that hold a Screen: while it records or is paused. */
export const liveDemonstrationStates = ["recording", "paused"] as const;

/** Whether a Demonstration still holds its Screen. */
export const isLiveDemonstration = (state: DemonstrationState) =>
  (liveDemonstrationStates as readonly DemonstrationState[]).includes(state);

/** What the user can do to a Demonstration from its Show me card. */
export type DemonstrationAction = "pause" | "resume" | "done" | "cancel";

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

/**
 * A step a Demonstration captured, as the user reads it back (#719): no selector and no
 * screenshot. A `pause` is the mark where the user paused, which the list shows as the gap.
 */
export type DemonstrationStep = {
  sequence: number;
  offsetMs: number;
  kind: "click" | "input" | "change" | "key" | "navigation" | "pause";
  url: string | null;
  label: string | null;
  value: string | null;
};
