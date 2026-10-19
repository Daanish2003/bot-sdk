import { eq } from "drizzle-orm";
import { z } from "zod";

import { bot, botRoutine, botTrigger } from "../../../core/server/db/schema";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { defineJob } from "../../runner/server/jobs/define";
import { fireKey, queueFire, routineFireJobName, routineSnapshot } from "./routine";
import { lockConversation, receive } from "./router";
import { nextSlot } from "./schedule";
import { hintChanged } from "./turn";

/**
 * One scheduled fire of a Routine (ADR 0011, the #537 amendment), at `slot`. Its one Checkpoint
 * queues the next fire and hands the Router the Routine's Trigger, so both happen once.
 */
export const routineFireJob = defineJob({
  name: routineFireJobName,
  payload: z.object({ routineId: z.uuid(), slot: z.iso.datetime() }),
  run: async ({ routineId, slot }, ctx) => {
    const deps = ctx.deps;
    const fired = await ctx.activity("fire", (tx) =>
      fireRoutine(deps, tx, routineId, new Date(slot)),
    );
    if (!fired) return;
    deps.plugin("runner").wake();
    await hintChanged(deps, fired.conversationId);
  },
  // A fire that failed for good queued no next fire (its Checkpoint rolled back): queue it here, so
  // one bad fire never stops the Routine.
  onFailed: async ({ routineId, slot }, _error, deps) => {
    await deps.db.transaction(async (tx) => {
      const [routine] = await tx
        .select({
          state: botRoutine.state,
          schedule: botRoutine.schedule,
          timeZone: botRoutine.timeZone,
        })
        .from(botRoutine)
        .where(eq(botRoutine.id, routineId))
        .for("update");
      if (routine?.state !== "active" || !routine.schedule) return;
      const after = new Date(Math.max(deps.clock().getTime(), new Date(slot).getTime()));
      await queueFire(deps, tx, routineId, nextSlot(routine.schedule, routine.timeZone, after));
    });
  },
});

/**
 * Fires the Routine's slot (#539): while it is `active`, queues its next fire, counted from now so a
 * late fire runs once, and hands the Router a `routine` / `schedule` Trigger carrying its snapshot.
 * The Trigger's ID is the slot's, so a slot never makes a second one. While the user's Quota is
 * spent, no Trigger is handed: there is no caller to show a 402 to. Returns the Conversation that
 * got a Trigger, or `null`.
 */
async function fireRoutine(
  deps: BotSdkContext,
  tx: Transaction,
  routineId: string,
  slot: Date,
): Promise<{ conversationId: string } | null> {
  const [owner] = await tx
    .select({ conversationId: bot.conversationId, userId: bot.userId, model: bot.model })
    .from(botRoutine)
    .innerJoin(bot, eq(bot.id, botRoutine.botId))
    .where(eq(botRoutine.id, routineId));
  if (!owner) return null;
  // The Quota is read before any lock is taken, so a slow read never holds up the Conversation.
  const call = await deps.plugin("models").resolveModelCall(owner.userId, owner.model);
  const quotaSpent = call ? !(await call.meter.mayRun()).ok : false;
  // The Conversation's row lock first, as in every transaction that hands the Router a Trigger.
  await lockConversation(tx, owner.conversationId);
  const [routine] = await tx
    .select()
    .from(botRoutine)
    .where(eq(botRoutine.id, routineId))
    .for("update");
  if (routine?.state !== "active" || !routine.schedule) return null;

  const now = deps.clock();
  // Counted from the slot at the earliest: a clock that reads just before it would queue this same
  // slot again, whose key this running fire still holds, and end the chain.
  const after = new Date(Math.max(now.getTime(), slot.getTime()));
  await queueFire(deps, tx, routineId, nextSlot(routine.schedule, routine.timeZone, after));

  if (quotaSpent) return null;
  const id = fireKey(routineId, slot);
  const [seen] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(eq(botTrigger.id, id));
  if (seen) return null;
  await receive(deps, tx, {
    id,
    conversationId: owner.conversationId,
    source: "routine",
    channel: "schedule",
    text: routineSnapshot({ ...routine, slot }),
    receivedAt: now,
  });
  return { conversationId: owner.conversationId };
}
