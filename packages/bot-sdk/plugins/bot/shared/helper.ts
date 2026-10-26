import { z } from "zod";

/** What a Helper works with (#565). */
export type HelperType = "general" | "computer_use";

/** How a Helper stands: live while `running` or `waiting` for the user, then it ends. */
export type HelperStatus = "running" | "waiting" | "complete" | "error" | "stopped";

/** Whether a Helper is still working or waiting on the user. */
export const isLiveHelper = (status: HelperStatus) => status === "running" || status === "waiting";

/**
 * A Helper as the client sees it (#590). `steps` are the model calls it has made, `latest` the
 * tool call of the newest one (a live Helper only), `report` its final text once it ended.
 * `afterMessageId` is the Message its card follows: the last of the Turn that started it.
 */
export type BotHelper = {
  id: string;
  type: HelperType;
  task: string;
  gist: string;
  status: HelperStatus;
  steps: number;
  latest: string | null;
  report: string | null;
  startedAt: Date;
  afterMessageId: string | null;
};

/**
 * The Computer card of a hand-off Message (#568), the Rich control of kind `computer`: the Helper
 * that handed its Screen to the user, why, and whether the user tapped Done or the task was stopped
 * first. The live link is never stored.
 */
export const computerCardSchema = z.object({
  kind: z.literal("computer"),
  helperId: z.string(),
  reason: z.string(),
  state: z.enum(["open", "done", "cancelled"]),
});

export type ComputerCard = z.infer<typeof computerCardSchema>;

/**
 * Where the HTTP layer serves the live view's proxy (#597), under its `basePath`:
 * `<path>/<view token>/…` serves a Screen's noVNC page and files, and
 * `<path>/<view token>/websockify` its socket.
 */
export const screenViewPath = "/screens";
