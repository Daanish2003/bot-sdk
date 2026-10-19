import { toolDefinition } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { botHelper, botHelperMessage } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { isLiveHelper } from "../shared/helper";
import { helperJobKey, startHelperTool } from "./helper";
import { listHelpers } from "./helper-card";
import type { LoopKit } from "./loop";

/** The Bot's tool that reads how one of its Helpers stands (#566). */
export const checkHelperToolName = "check_helper";

/** The Bot's tool that passes a Message to one of its live Helpers (#566). */
export const messageHelperToolName = "message_helper";

/** The Bot's tool that stops one of its Helpers, or all of them (#566). */
export const stopHelpersToolName = "stop_helpers";

export const noHelperError = "No Helper with that id; your to-do list shows the current ones.";

export const helperFinishedError =
  "That Helper already finished. Read its report, or start a new one.";

const helperIdSchema = z.string().meta({
  description: "The Helper's id, from start_helper or your to-do list.",
});

const checkHelperDefinition = toolDefinition({
  name: checkHelperToolName,
  description:
    "Check on one of your Helpers, for when the user asks how it's going. It returns the Helper's " +
    "status, its task, its Steps so far, its latest action, and its report once it has ended.",
  inputSchema: z.object({ helperId: helperIdSchema }),
});

const messageHelperDefinition = toolDefinition({
  name: messageHelperToolName,
  description:
    "Send a message to one of your Helpers that is still working or waiting, such as the user's " +
    "new instructions for its task. It reads the message before its next step.",
  inputSchema: z.object({
    helperId: helperIdSchema,
    text: z.string().trim().min(1, "text must not be empty").meta({
      description: "The message, written so it stands alone.",
    }),
  }),
});

const stopHelpersDefinition = toolDefinition({
  name: stopHelpersToolName,
  description:
    "Stop one of your Helpers, or all of them when you give no id, when the user no longer needs " +
    "the work. A stopped Helper sends no report.",
  inputSchema: z.object({ helperId: helperIdSchema.optional() }),
});

/** What the Helper tools need of the Turn that calls them. */
type HelperCaller = Parameters<typeof startHelperTool>[1];

/** A live Helper of `botId` with id `helperId`, or the refusal for one that isn't. */
async function liveHelper(
  tx: Transaction,
  botId: string,
  helperId: string,
): Promise<{ error: string } | undefined> {
  if (!z.uuid().safeParse(helperId).success) return { error: noHelperError };
  const [row] = await tx
    .select({ status: botHelper.status })
    .from(botHelper)
    .where(and(eq(botHelper.id, helperId), eq(botHelper.botId, botId)));
  if (!row) return { error: noHelperError };
  if (!isLiveHelper(row.status)) return { error: helperFinishedError };
  return undefined;
}

/**
 * Stops the Bot's Helper `helperId`, or every live one when it's absent (#566): each turns
 * `stopped` and its job is cancelled through the runner, and it sends no `helper` Trigger (its
 * job's finish only ends a `running` Helper). Refuses an id that isn't the Bot's or has ended.
 */
export async function stopHelpers(
  deps: BotSdkContext,
  tx: Transaction,
  botId: string,
  helperId?: string,
): Promise<{ stopped: string[] } | { error: string }> {
  if (helperId !== undefined) {
    const refused = await liveHelper(tx, botId, helperId);
    if (refused) return refused;
  }
  // The Helper's row before its job's, as its job's last Checkpoint takes them, so the two can't
  // deadlock.
  const rows = await tx
    .update(botHelper)
    .set({ status: "stopped", endedAt: deps.clock() })
    .where(
      and(
        eq(botHelper.botId, botId),
        inArray(botHelper.status, ["running", "waiting"]),
        helperId === undefined ? undefined : eq(botHelper.id, helperId),
      ),
    )
    .returning({ id: botHelper.id });
  const runner = deps.plugin("runner");
  for (const { id } of rows) await runner.cancelIn(tx, helperJobKey(id));
  return { stopped: rows.map((row) => row.id) };
}

/**
 * The Bot's Helper tools (#566), each call one Checkpoint: `start_helper`, `check_helper`,
 * `message_helper` and `stop_helpers`.
 */
export function helperTools(
  deps: BotSdkContext,
  turn: HelperCaller,
  liveActivity: LoopKit["liveActivity"],
) {
  const check = checkHelperDefinition.server(async ({ helperId }, context) =>
    liveActivity(checkHelperToolName, context?.toolCallId, async () => {
      if (!z.uuid().safeParse(helperId).success) return { error: noHelperError };
      const [helper] = await listHelpers(deps.db, turn.botId, helperId);
      if (!helper) return { error: noHelperError };
      const { status, task, steps, latest, report } = helper;
      return { status, task, steps, latest, report };
    }),
  );

  const message = messageHelperDefinition.server(async ({ helperId, text }, context) =>
    liveActivity(messageHelperToolName, context?.toolCallId, async (tx) => {
      const refused = await liveHelper(tx, turn.botId, helperId);
      if (refused) return refused;
      await tx
        .insert(botHelperMessage)
        .values({ id: uuidv7(), helperId, text, createdAt: deps.clock() });
      return { sent: true as const };
    }),
  );

  const stop = stopHelpersDefinition.server(async ({ helperId }, context) =>
    liveActivity(stopHelpersToolName, context?.toolCallId, (tx) =>
      stopHelpers(deps, tx, turn.botId, helperId),
    ),
  );

  return [startHelperTool(deps, turn, liveActivity), check, message, stop];
}
