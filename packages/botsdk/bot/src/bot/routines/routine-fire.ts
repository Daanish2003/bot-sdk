import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { bot, botRoutine, botTrigger } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { activeJobsByKeyPrefix, defineCoreJob, idsWithoutActiveJob } from "../../runner/internal";
import { fireKey, fireKeyPrefix, queueFire, routineFireJobName, routineSnapshot } from "./routine";
import { lockConversation, receive } from "../triggers";
import { nextSlot } from "./schedule";
import { hintChanged, recordBotChange } from "../conversation";

/**
 * One scheduled fire of a Routine (ADR 0011, the #537 amendment), at `slot`. Its one Checkpoint
 * queues the next fire and hands the Router the Routine's Trigger, so both happen once.
 */
export const routineFireJob = defineCoreJob({
  name: routineFireJobName,
  payload: z.object({ routineId: z.uuid(), slot: z.iso.datetime() }),
  run: async ({ routineId, slot }, ctx) => {
    const deps = ctx.deps;
    const fired = await ctx.step("fire", (tx) => fireRoutine(deps, tx, routineId, new Date(slot)));
    if (!fired) return;
    if (fired.woke) deps.runner.wake();
    await hintChanged(deps, fired.conversationId);
  },
  // A fire that failed for good queued no next fire (its Checkpoint rolled back): queue it here, so
  // one bad fire never stops the Routine.
  onFailed: async ({ routineId, slot }, _error, { deps }) => {
    const changed = await deps.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ conversationId: bot.conversationId })
        .from(botRoutine)
        .innerJoin(bot, eq(bot.id, botRoutine.botId))
        .where(eq(botRoutine.id, routineId));
      if (!owner) return null;
      // The Conversation's row lock first, as in every write that changes the Bot thread.
      await lockConversation(tx, owner.conversationId);
      const [routine] = await tx
        .select({
          state: botRoutine.state,
          schedule: botRoutine.schedule,
          timeZone: botRoutine.timeZone,
        })
        .from(botRoutine)
        .where(eq(botRoutine.id, routineId))
        .for("update");
      if (routine?.state !== "active" || !routine.schedule) return null;
      const now = deps.clock();
      const after = new Date(Math.max(now.getTime(), new Date(slot).getTime()));
      await queueFire(deps, tx, routineId, nextSlot(routine.schedule, routine.timeZone, after));
      // Its next run moved.
      await recordBotChange(tx, owner, "routine", routineId, now);
      return owner;
    });
    if (changed) await hintChanged(deps, changed.conversationId);
  },
});

/**
 * Fires the Routine's slot (#539): while it is `active`, queues its next fire, counted from now so a
 * late fire runs once, and hands the Router a `routine` / `schedule` Trigger carrying its snapshot.
 * The Trigger's ID is the slot's, so a slot never makes a second one. While the user's Quota is
 * spent, no Trigger is handed: there is no caller to show a 402 to. Nor while the user is Banned
 * (#585); the next fire is still queued, so the Routine fires again once the Ban ends. Its next run
 * is a `routine` change. Returns the Conversation and whether it got a Trigger (`woke`), or `null`
 * when the Routine no longer fires.
 */
async function fireRoutine(
  deps: BotSdkContext,
  tx: Transaction,
  routineId: string,
  slot: Date,
): Promise<{ conversationId: string; woke: boolean } | null> {
  const [owner] = await tx
    .select({ conversationId: bot.conversationId, userId: bot.userId, model: bot.model })
    .from(botRoutine)
    .innerJoin(bot, eq(bot.id, botRoutine.botId))
    .where(eq(botRoutine.id, routineId));
  if (!owner) return null;
  // The Quota and the Ban are read before any lock is taken, so a slow read never holds up the
  // Conversation.
  const call = await deps.models.resolveModelCall(owner.userId, owner.model);
  const quotaSpent = call ? !(await call.meter.mayRun()).ok : false;
  const banned = await deps.isUserBlocked(owner.userId);
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
  await recordBotChange(tx, owner, "routine", routineId, now);
  const fired = { conversationId: owner.conversationId, woke: false };

  if (quotaSpent || banned) return fired;
  const id = fireKey(routineId, slot);
  const [seen] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(eq(botTrigger.id, id));
  if (seen) return fired;
  await receive(deps, tx, {
    id,
    conversationId: owner.conversationId,
    source: "routine",
    channel: "schedule",
    text: routineSnapshot({ ...routine, slot }),
    receivedAt: now,
  });
  return { ...fired, woke: true };
}

/** The runner job that repairs broken chains of Routine fires (#578). */
const routineReconcileJobName = "bot.routine_reconcile";

/**
 * How often the reconcile runs: a broken chain is found within the hour, and the next slot from
 * then is queued.
 */
const reconcileEveryMs = 60 * 60_000;

/**
 * Queues the reconcile at `at`. Its key is `at`, so the boots and runs that queue the same time
 * share one job.
 */
async function queueReconcile(deps: BotSdkContext, at: Date): Promise<void> {
  await deps.runner.enqueue(
    routineReconcileJobName,
    { at: at.toISOString() },
    { idempotencyKey: `routine_reconcile:${at.toISOString()}`, runAfter: at },
  );
}

/**
 * Starts the reconcile when the SDK starts: one runs now, then each queues the next on the hour, so
 * however many times the SDK starts, one chain of reconciles runs.
 */
export const startRoutineReconcile = (deps: BotSdkContext) => queueReconcile(deps, deps.clock());

/**
 * Queues the next fire of every active scheduled Routine that has none (#578): one whose chain of
 * fires broke, because its `onFailed` threw or the process died during it. The next reconcile is
 * queued first, and again by `onFailed`, so one that fails never ends the chain of reconciles. A
 * Routine that fails to repair is logged and the rest are still repaired.
 */
export const routineReconcileJob = defineCoreJob({
  name: routineReconcileJobName,
  payload: z.object({ at: z.iso.datetime() }),
  run: async ({ at }, { deps }) => {
    await queueNextReconcile(deps, new Date(at));
    const broken = await idsWithoutActiveJob(deps.db, {
      from: botRoutine,
      id: botRoutine.id,
      where: and(eq(botRoutine.state, "active"), isNotNull(botRoutine.schedule)),
      name: routineFireJobName,
      keyPrefix: (id) => fireKeyPrefix(id),
    });
    for (const id of broken) {
      await repairChain(deps, id).catch((error: unknown) =>
        deps.logger.error(`Repairing the fires of Routine ${id} failed`, error),
      );
    }
  },
  onFailed: ({ at }, _error, { deps }) => queueNextReconcile(deps, new Date(at)),
});

/**
 * Queues the reconcile after the one at `at`, on the next hour. Counted from `at` at the earliest: a
 * clock that reads just before it would queue that same reconcile again, whose key a running one
 * still holds, and end the chain.
 */
function queueNextReconcile(deps: BotSdkContext, at: Date): Promise<void> {
  const after = Math.max(deps.clock().getTime(), at.getTime());
  return queueReconcile(
    deps,
    new Date((Math.floor(after / reconcileEveryMs) + 1) * reconcileEveryMs),
  );
}

/**
 * Queues the next slot's fire of the Routine `routineId`, counted from now, while it is still
 * active, scheduled and without a fire. Its Conversation's row lock first, as a fire takes them.
 */
async function repairChain(deps: BotSdkContext, routineId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ conversationId: bot.conversationId })
      .from(botRoutine)
      .innerJoin(bot, eq(bot.id, botRoutine.botId))
      .where(eq(botRoutine.id, routineId));
    if (!owner) return;
    await lockConversation(tx, owner.conversationId);
    const [routine] = await tx
      .select({ schedule: botRoutine.schedule, timeZone: botRoutine.timeZone })
      .from(botRoutine)
      .where(and(eq(botRoutine.id, routineId), eq(botRoutine.state, "active")))
      .for("update");
    if (!routine?.schedule) return;
    const fires = await activeJobsByKeyPrefix(tx, {
      name: routineFireJobName,
      keyPrefixes: [fireKeyPrefix(routineId)],
    });
    if (fires.length > 0) return;
    await queueFire(
      deps,
      tx,
      routineId,
      nextSlot(routine.schedule, routine.timeZone, deps.clock()),
    );
  });
}
