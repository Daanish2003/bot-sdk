import { and, eq, inArray, isNull, max, min, or, type SQL } from "drizzle-orm";

import { bot, botTrigger, botTurn, conversation, message } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { recordBotChange } from "../conversation";
import { checkInOfKey, routineOfFireKey } from "./trigger-ids";

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
 * A Bot in one Conversation (spec #1055): the key of its Conversation queue and of its Turns there.
 * A Bot's 1:1 Conversation has only it.
 */
export type BotConversation = { botId: string; conversationId: string };

/**
 * The Conversation queue (#499) of a Bot in a Conversation: its Triggers there that no Turn has
 * taken yet and that were not skipped (spec #1007), in every Conversation when none is given (the
 * Tasks view). A skipped Trigger is never taken.
 */
export function waitingIn({
  botId,
  conversationId,
}: {
  botId: string;
  conversationId?: string;
}): SQL | undefined {
  return and(
    conversationId ? eq(botTrigger.conversationId, conversationId) : undefined,
    eq(botTrigger.botId, botId),
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
 * Takes the row locks of Conversations `ids` in id order (spec #1055). A transaction that locks more
 * than one Conversation takes them this way, first, so two never wait on each other in a circle:
 * a Room Turn's end writes its Bot's 1:1 Conversation too (`endTurn`), and a pause locks the 1:1 and
 * every Room of the Bot.
 */
export async function lockConversationsInOrder(tx: Transaction, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockConversation(tx, id);
}

/** The ids of Bots `botIds`' 1:1 Conversations. */
export async function oneToOnesOf(tx: Transaction, botIds: string[]): Promise<string[]> {
  if (botIds.length === 0) return [];
  const rows = await tx.select({ id: bot.conversationId }).from(bot).where(inArray(bot.id, botIds));
  return rows.map((row) => row.id);
}

/**
 * Takes the row locks a transaction that ends Bot `botId`'s Turn in `conversationId` needs, in id
 * order: that Conversation's and, for a Room Turn, the Bot's 1:1 Conversation's.
 */
export async function lockTurnConversations(
  tx: Transaction,
  { botId, conversationId }: BotConversation,
): Promise<void> {
  await lockConversationsInOrder(tx, [conversationId, ...(await oneToOnesOf(tx, [botId]))]);
}

/**
 * Whether Bot `botId` is paused (Bot pause, spec #1007). Read it under the Conversation's row lock,
 * which a pause and a resume take.
 */
export async function isPaused(tx: Transaction, botId: string): Promise<boolean> {
  const [row] = await tx.select({ pausedAt: bot.pausedAt }).from(bot).where(eq(bot.id, botId));
  return row !== undefined && row.pausedAt !== null;
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
  const routineId = trigger.source === "routine" ? routineOfFireKey(trigger.id) : undefined;
  const checkInId = trigger.source === "check_in" ? checkInOfKey(trigger.id) : undefined;
  if (routineId) await recordBotChange(tx, owner, "routine", routineId, at);
  else if (checkInId) await recordBotChange(tx, owner, "check_in", checkInId, at);
  else await recordBotChange(tx, owner, "bot", owner.botId, at);
}

/**
 * Skips every Trigger waiting in the Bot's Conversation queue with `reason` (spec #1007), in `tx`,
 * which holds the Conversation's row lock: no Turn takes them, and the Tasks view lists them as
 * skipped.
 */
export async function skipWaiting(
  tx: Transaction,
  owner: BotConversation,
  reason: "cancelled" | "paused" | "reset",
  at: Date,
): Promise<void> {
  await tx.update(botTrigger).set({ skippedAt: at, skipReason: reason }).where(waitingIn(owner));
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
  const owner = { botId: trigger.botId, conversationId: trigger.conversationId };
  await lockConversation(tx, owner.conversationId);
  if (await isPaused(tx, owner.botId)) {
    const now = deps.clock();
    await tx.insert(botTrigger).values({ ...trigger, skippedAt: now, skipReason: "paused" });
    await recordSkipChange(tx, owner, trigger, now);
    return {};
  }
  await tx.insert(botTrigger).values(trigger);
  const running = await runningTurnOf(tx, owner);
  if (!running) return { takenBy: await startTurn(deps, tx, owner) };
  const received = and(eq(botTrigger.id, trigger.id), eq(botTrigger.botId, owner.botId));
  // While the running Turn's job hasn't started (`replaceIfNotStarted`), it is replaced in this
  // transaction by one that also takes the Trigger, and the Turn is relinked to it.
  const runAfter = await batchClosesAt(deps, tx, or(eq(botTrigger.turnId, running), received));
  const jobId = await deps.runner.replaceIfNotStarted(
    tx,
    running,
    botTurnJobName,
    { turnId: running },
    { runAfter: new Date(runAfter) },
  );
  if (!jobId) return { waitsFor: running };
  wakeWhenDue(deps, runAfter);
  await tx.update(botTrigger).set({ turnId: running }).where(received);
  await tx.update(botTurn).set({ jobId }).where(eq(botTurn.id, running));
  return { takenBy: running };
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

/** The id of the Bot's running Turn in the Conversation, or `undefined` when none runs there. */
export async function runningTurnOf(
  tx: Transaction,
  { botId, conversationId }: BotConversation,
): Promise<string | undefined> {
  const [running] = await tx
    .select({ id: botTurn.id })
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, botId),
        eq(botTurn.conversationId, conversationId),
        eq(botTurn.status, "running"),
      ),
    )
    .limit(1);
  return running?.id;
}

/**
 * Creates a Turn that takes every Trigger waiting in the Bot's Conversation queue, and queues its
 * job. It cancels the Bot's away Summary, so the user's Turn is never delayed by one.
 */
export async function startTurn(
  deps: BotSdkContext,
  tx: Transaction,
  owner: BotConversation,
): Promise<string | undefined> {
  const { botId, conversationId } = owner;
  const waiting = waitingIn(owner);
  const [first] = await tx.select({ id: botTrigger.id }).from(botTrigger).where(waiting).limit(1);
  if (!first) return undefined;
  await cancelAwaySummary(deps, tx, botId);
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
    botId,
    conversationId,
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
    .select({ botId: botTurn.botId, conversationId: botTurn.conversationId })
    .from(botTurn)
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
  const [waiting] = await messagesOf(waitingIn(turn));
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
  await recordBotChange(tx, { conversationId: turn.conversationId }, "turn", turnId, new Date(now));
}
