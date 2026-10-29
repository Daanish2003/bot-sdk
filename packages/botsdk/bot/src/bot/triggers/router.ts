import { and, eq, isNull, max, min, or, type SQL } from "drizzle-orm";

import { bot, botTrigger, botTurn, conversation, message } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { recordBotChange } from "../conversation";

/** The runner job that runs one Turn (`botTurnJob` in `turn.ts`). */
export const botTurnJobName = "bot.turn";

/** The key of a Bot's away Summary job: one per Bot at a time. */
export const awaySummaryKey = (botId: string) => `summary-away:${botId}`;

/** Cancels the Bot's away Summary, queued or running, in `tx`: a Turn is starting. */
export async function cancelAwaySummary(
  deps: BotSdkContext,
  tx: Transaction,
  botId: string,
): Promise<void> {
  await deps.runner.cancelIn(tx, awaySummaryKey(botId));
}

/**
 * Batching quick Messages (#501): a Turn's job starts once `batchQuietMs` pass with no new Trigger,
 * and never later than `batchLongestMs` after the first Trigger it took. There is no cap. The
 * lecture leaves the heuristic open, so these are a recorded deviation: 500 ms is OpenClaw's queue
 * debounce default, and 2.5 s is OpenClaw's rule that a batch closes at 5 × the debounce. Hermes's
 * 0.35 s / 1.0 s was rejected as tuned for a fast phone typist, too tight for three deliberate
 * Messages (#497).
 */
export const batchQuietMs = 500;
export const batchLongestMs = 2_500;

/** A Trigger as the Router receives it: its row, before any Turn has taken or skipped it. */
export type ReceivedTrigger = Omit<
  typeof botTrigger.$inferInsert,
  "turnId" | "skippedAt" | "skipReason"
>;

/**
 * The Conversation queue (#499): the Conversation's Triggers that no Turn has taken yet and that
 * were not skipped (spec #1007). A skipped Trigger is never taken.
 */
export function waitingIn(conversationId: string): SQL | undefined {
  return and(
    eq(botTrigger.conversationId, conversationId),
    isNull(botTrigger.turnId),
    isNull(botTrigger.skippedAt),
  );
}

/**
 * Takes the Conversation's row lock. Every transaction that starts or ends a Turn takes it first,
 * so a Conversation runs one Turn at a time (#499); the running-Turn index backs it up.
 */
export async function lockConversation(tx: Transaction, conversationId: string): Promise<void> {
  await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .for("update");
}

/**
 * Whether the Bot of Conversation `conversationId` is paused (Bot pause, spec #1007), with its id.
 * Read it under the Conversation's row lock, which a pause and a resume take.
 */
export async function pauseOf(
  tx: Transaction,
  conversationId: string,
): Promise<{ botId: string; paused: boolean } | undefined> {
  const [row] = await tx
    .select({ botId: bot.id, pausedAt: bot.pausedAt })
    .from(bot)
    .where(eq(bot.conversationId, conversationId));
  return row && { botId: row.botId, paused: row.pausedAt !== null };
}

/**
 * Records the change a skipped Trigger makes, in `tx`, so open Tasks views refresh (spec #1007): a
 * Routine's run is its Routine's change, a Check-in's fire its Check-in's, and any other its Bot's.
 */
export async function recordSkipChange(
  tx: Transaction,
  owner: { conversationId: string; botId: string },
  trigger: { id: string; source: ReceivedTrigger["source"] },
  at: Date,
): Promise<void> {
  const routineId =
    trigger.source === "routine" ? /^routine:([0-9a-f-]{36}):/.exec(trigger.id)?.[1] : undefined;
  const checkInId =
    trigger.source === "check_in" ? /^check_in:([0-9a-f-]{36})$/.exec(trigger.id)?.[1] : undefined;
  if (routineId) await recordBotChange(tx, owner, "routine", routineId, at);
  else if (checkInId) await recordBotChange(tx, owner, "check_in", checkInId, at);
  else await recordBotChange(tx, owner, "bot", owner.botId, at);
}

/**
 * Skips every Trigger waiting in the Conversation queue with `reason` (spec #1007), in `tx`, which
 * holds the Conversation's row lock: no Turn takes them, and the Tasks view lists them as skipped.
 */
export async function skipWaiting(
  tx: Transaction,
  conversationId: string,
  reason: "paused" | "reset",
  at: Date,
): Promise<void> {
  await tx
    .update(botTrigger)
    .set({ skippedAt: at, skipReason: reason })
    .where(waitingIn(conversationId));
}

/**
 * The Router's way in (#499): queues the Trigger in its Conversation queue and, when no Turn is
 * running, starts one that takes it. While the running Turn's job hasn't started, the Trigger joins
 * that Turn and pushes back its job (#501). Returns `takenBy`, the Turn that took it, or, when the
 * Trigger waits for the Turn that follows the running one, `waitsFor`, that running Turn. While its
 * Bot is paused (spec #1007), the Trigger is kept as skipped with reason `paused` and starts no
 * Turn, so it returns neither. Call the runner's `wake()` once `tx` has committed.
 */
export async function receive(
  deps: BotSdkContext,
  tx: Transaction,
  trigger: ReceivedTrigger,
): Promise<{ takenBy?: string; waitsFor?: string }> {
  await lockConversation(tx, trigger.conversationId);
  const owner = await pauseOf(tx, trigger.conversationId);
  if (owner?.paused) {
    const now = deps.clock();
    await tx.insert(botTrigger).values({ ...trigger, skippedAt: now, skipReason: "paused" });
    await recordSkipChange(
      tx,
      { conversationId: trigger.conversationId, botId: owner.botId },
      trigger,
      now,
    );
    return {};
  }
  await tx.insert(botTrigger).values(trigger);
  const [running] = await tx
    .select({ id: botTurn.id })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(and(eq(bot.conversationId, trigger.conversationId), eq(botTurn.status, "running")))
    .limit(1);
  if (!running) return { takenBy: await startTurn(deps, tx, trigger.conversationId) };
  // While the running Turn's job hasn't started (`replaceIfNotStarted`), it is replaced in this
  // transaction by one that also takes the Trigger, and the Turn is relinked to it.
  const runAfter = await batchClosesAt(
    deps,
    tx,
    or(eq(botTrigger.turnId, running.id), eq(botTrigger.id, trigger.id)),
  );
  const jobId = await deps.runner.replaceIfNotStarted(
    tx,
    running.id,
    botTurnJobName,
    { turnId: running.id },
    { runAfter: new Date(runAfter) },
  );
  if (!jobId) return { waitsFor: running.id };
  wakeWhenDue(deps, runAfter);
  await tx.update(botTrigger).set({ turnId: running.id }).where(eq(botTrigger.id, trigger.id));
  await tx.update(botTurn).set({ jobId }).where(eq(botTurn.id, running.id));
  return { takenBy: running.id };
}

/**
 * When the batch of `triggers` closes (#501), in ms: `batchQuietMs` after the newest, and no later
 * than `batchLongestMs` after the first.
 */
async function batchClosesAt(
  deps: BotSdkContext,
  tx: Transaction,
  triggers: SQL | undefined,
): Promise<number> {
  const [batch] = await tx
    .select({ first: min(botTrigger.receivedAt), newest: max(botTrigger.receivedAt) })
    .from(botTrigger)
    .where(triggers);
  const now = deps.clock().getTime();
  const first = batch?.first?.getTime() ?? now;
  const newest = batch?.newest?.getTime() ?? now;
  return Math.min(newest + batchQuietMs, first + batchLongestMs);
}

/**
 * The runner polls every few seconds, so it is woken when a Turn's job falls due at `runAfter`. By
 * then the transaction that queued it has long committed; if not, the next poll claims the job.
 */
function wakeWhenDue(deps: BotSdkContext, runAfter: number): void {
  const now = deps.clock().getTime();
  if (runAfter > now) setTimeout(() => deps.runner.wake(), runAfter - now).unref?.();
}

/**
 * Queues the job of Turn `turnId`, to run once the batch of `triggers` is closed (#501), and
 * returns the job's id.
 */
async function enqueueTurnJob(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
  triggers: SQL | undefined,
): Promise<string> {
  const runAfter = await batchClosesAt(deps, tx, triggers);
  const jobId = await deps.runner.enqueueIn(
    tx,
    botTurnJobName,
    { turnId },
    { idempotencyKey: turnId, runAfter: new Date(runAfter) },
  );
  wakeWhenDue(deps, runAfter);
  return jobId;
}

/**
 * Creates a Turn that takes every Trigger waiting in the Conversation queue, and queues its job. It
 * cancels the Bot's away Summary, so the user's Turn is never delayed by one.
 */
export async function startTurn(
  deps: BotSdkContext,
  tx: Transaction,
  conversationId: string,
): Promise<string | undefined> {
  const waiting = waitingIn(conversationId);
  const [first] = await tx.select({ id: botTrigger.id }).from(botTrigger).where(waiting).limit(1);
  if (!first) return undefined;
  const [owner] = await tx
    .select({ id: bot.id })
    .from(bot)
    .where(eq(bot.conversationId, conversationId));
  if (!owner) throw new Error(`Conversation ${conversationId} has no Bot`);
  await cancelAwaySummary(deps, tx, owner.id);
  // Until its job starts and sets it (`turnStarted`), the Turn starts after every Message its
  // Triggers carry, even one stamped by a process whose clock runs ahead.
  const [newest] = await tx
    .select({ at: max(message.createdAt) })
    .from(botTrigger)
    .innerJoin(message, eq(message.id, botTrigger.messageId))
    .where(waiting);
  const startedAt = Math.max(deps.clock().getTime(), newest?.at?.getTime() ?? 0) + 1;
  const turnId = uuidv7();
  const jobId = await enqueueTurnJob(deps, tx, turnId, waiting);
  await tx.insert(botTurn).values({
    id: turnId,
    botId: owner.id,
    status: "running",
    startedAt: new Date(startedAt),
    jobId,
  });
  await tx.update(botTrigger).set({ turnId }).where(waiting);
  await recordBotChange(tx, { conversationId }, "turn", turnId, deps.clock());
  return turnId;
}

/**
 * Starts Turn `turnId` (#501), in its job's first Checkpoint: sets its `startedAt` under the
 * Conversation's row lock. From then on Triggers wait for the next Turn, and the 5-minute limit
 * counts from it.
 */
export async function turnStarted(deps: BotSdkContext, tx: Transaction, turnId: string) {
  const [turn] = await tx
    .select({ conversationId: bot.conversationId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  if (!turn) return;
  await lockConversation(tx, turn.conversationId);
  const messagesOf = (triggers: SQL | undefined) =>
    tx
      .select({ first: min(message.createdAt), newest: max(message.createdAt) })
      .from(botTrigger)
      .innerJoin(message, eq(message.id, botTrigger.messageId))
      .where(triggers);
  const [taken] = await messagesOf(eq(botTrigger.turnId, turnId));
  const [waiting] = await messagesOf(waitingIn(turn.conversationId));
  // The Turn's input is the user Messages saved before it starts. It starts after every Message its
  // Triggers carry, even one stamped by a process whose clock runs ahead, and before any that came
  // once the job was claimed: those wait for the next Turn.
  const now = deps.clock().getTime();
  const startedAt = Math.max(
    (taken?.newest?.getTime() ?? 0) + 1,
    Math.min(now, waiting?.first?.getTime() ?? now),
  );
  await tx
    .update(botTurn)
    .set({ startedAt: new Date(startedAt) })
    .where(eq(botTurn.id, turnId));
  await recordBotChange(tx, turn, "turn", turnId, new Date(now));
}
