import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { bot, botReview, botTrigger, job } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import {
  defineCoreJob,
  type JobContext,
  type CoreJobServices,
  loadHistory,
} from "../../runner/internal";
import {
  capResult,
  computerFailureResult,
  computerOf,
  computerUnavailableError,
  type FileToolOptions,
  rebuiltNote,
  runShell,
  type ShellInput,
  shellToolName,
  spillPath,
} from "../agent-loop";
import { featureTools, featureTurnOf } from "../context";
import { computerRebuildSeenAt, hintChanged, markComputerRebuildSeen } from "../conversation";
import { lockConversation, receive } from "../triggers";
import {
  approvalTriggerId,
  approvalTriggerText,
  approvedCallJobName,
  approvedCallKey,
} from "../safety";

/*
 * The approved-call job (ADR 0030): when the user allows a call whose Approval went pending, it
 * runs the stored call outside any Turn, exactly as it was asked, with no second review, and wakes
 * the Bot with its result as an Approval Trigger. Whatever stops the call (a spent Quota, a broken
 * Connection, a failed command) is its result: it never retries the call.
 */

/** What the call's result is when the user's Quota is spent. */
export const approvedQuotaSpentError =
  "The approved call didn't run: the user's Quota is spent. Tell the user.";

/** What a call that started but has no result is, after a restart: it may have partly run. */
export const interruptedApprovedCallError =
  "The approved call was interrupted by a restart and may have partly run. Check its effects " +
  "before running it again.";

/** What the call is when the job gave up on it before its result was saved. */
export const failedApprovedCallError =
  "The approved call couldn't finish: it may not have run, or only partly. Check before trying " +
  "it again.";

/** What a call to a tool the Bot no longer has is. */
export const unavailableToolError = (tool: string) => `The tool ${tool} isn't available any more.`;

/** The activity that runs the stored call, whose Checkpoint holds its result. */
const callActivity = "call";

/** An allowed review's stored call, with its Bot. */
type StoredCall = {
  reviewId: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  userId: string;
  botId: string;
  model: string;
  conversationId: string;
};

export const approvedCallJob = defineCoreJob({
  name: approvedCallJobName,
  payload: z.object({ reviewId: z.uuid() }),
  run: async ({ reviewId }, ctx) => {
    const deps = ctx.deps;
    // A Bot deleted since took its review with it: there is no one to wake.
    const call = await storedCall(deps, reviewId);
    if (!call) return;
    const result = await runStoredCall(deps, ctx, call);
    const woke = await ctx.step("trigger", (tx) => wakeWith(deps, tx, call, result));
    if (!woke) return;
    deps.runner.wake();
    await hintChanged(deps, call.conversationId);
  },
  // A job that failed for good still wakes the Bot, so it never waits on the call: with the
  // call's result when its Checkpoint was saved, else with the failure.
  onFailed: async ({ reviewId }, _error, { deps }) => {
    const call = await storedCall(deps, reviewId);
    if (!call) return;
    const saved = await savedResult(deps, reviewId);
    const result = saved ? saved.result : { error: failedApprovedCallError };
    const woke = await deps.db.transaction((tx) => wakeWith(deps, tx, call, result));
    if (!woke) return;
    deps.runner.wake();
    await hintChanged(deps, call.conversationId);
  },
});

/** Review `reviewId`'s stored call while it is `allowed`, with its Bot, or `null`. */
async function storedCall(deps: BotSdkContext, reviewId: string): Promise<StoredCall | null> {
  const [row] = await deps.db
    .select({
      reviewId: botReview.id,
      toolCallId: botReview.toolCallId,
      tool: botReview.tool,
      input: botReview.input,
      summary: botReview.summary,
      userId: bot.userId,
      botId: bot.id,
      model: bot.model,
      conversationId: bot.conversationId,
    })
    .from(botReview)
    .innerJoin(bot, eq(bot.id, botReview.botId))
    .where(and(eq(botReview.id, reviewId), eq(botReview.state, "allowed")));
  return row ?? null;
}

/** The result the job of review `reviewId` saved for its call, if its Checkpoint was saved. */
async function savedResult(
  deps: BotSdkContext,
  reviewId: string,
): Promise<{ result: unknown } | undefined> {
  const [ran] = await deps.db
    .select({ id: job.id })
    .from(job)
    .where(eq(job.idempotencyKey, approvedCallKey(reviewId)))
    .orderBy(desc(job.createdAt))
    .limit(1);
  if (!ran) return undefined;
  const saved = (await loadHistory(deps.db, ran.id)).find(
    (entry) => entry.kind === "activity" && entry.name === callActivity,
  );
  return saved && { result: saved.result };
}

/**
 * Runs the stored call once: the Quota first, then the one tool it names, rebuilt for its Bot.
 * The start marker means a call a crash cut off is never run again: its result says it may have
 * partly run.
 */
async function runStoredCall(
  deps: BotSdkContext,
  ctx: JobContext<CoreJobServices>,
  call: StoredCall,
): Promise<unknown> {
  // As a Turn's start checks it: the result wakes a Turn on the Bot's Model.
  const quotaSpent = await ctx.step("quota", async () => {
    const model = await deps.models.resolveModelCall(call.userId, call.model);
    return model ? !(await model.meter.mayRun()).ok : false;
  });
  if (quotaSpent) return { error: approvedQuotaSpentError };
  // Closes whatever the call opened (a Connection's client) once it ends, or on a cancel.
  const connections = new AbortController();
  const cancel = () => connections.abort();
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    const shell = call.tool === shellToolName ? shellCall(deps, call, connections.signal) : null;
    const run = shell?.run ?? (await featureCall(deps, ctx, call, connections.signal));
    if (typeof run !== "function") return run;
    let startedHere = false;
    await ctx.step(
      "call_start",
      async () => {
        startedHere = true;
        return null;
      },
      { yields: false },
    );
    // No transaction: the call runs on the Computer or a Connection, not in the database.
    const result = await ctx.step(callActivity, async () => {
      if (!startedHere) return { error: interruptedApprovedCallError };
      return run();
    });
    // Once its result is saved, a rebuild it told the Bot of is recorded as told; a crash before
    // then tells it again rather than never.
    await shell?.told();
    return result;
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
    connections.abort();
  }
}

/**
 * The stored `shell` call, as a Turn runs it: its Secrets, masking and cut, and the rebuilt note
 * for a rebuild of the Computer the Bot wasn't told of, which `told` then records as told.
 */
function shellCall(deps: BotSdkContext, call: StoredCall, signal: AbortSignal) {
  let telling: Date | undefined;
  const onComputer = async <T extends object>(
    operate: (computer: ReturnType<typeof computerOf>, live: FileToolOptions) => Promise<T>,
  ): Promise<T | { error: string }> => {
    if (!deps.computer) return { error: computerUnavailableError };
    const computer = computerOf(deps, call.userId);
    try {
      const result = await operate(computer, { signal });
      const rebuild = computer.rebuild();
      if (!rebuild) return result;
      const seenAt = await computerRebuildSeenAt(deps.db, call.botId);
      if (seenAt && rebuild.rebuiltAt <= seenAt) return result;
      telling = rebuild.rebuiltAt;
      return { ...result, note: rebuiltNote(rebuild) };
    } catch (caught) {
      const failed = signal.aborted ? undefined : computerFailureResult(caught);
      if (failed) return failed;
      throw caught;
    }
  };
  return {
    run: () =>
      runShell(
        deps,
        { userId: call.userId, botId: call.botId, toolCallId: call.toolCallId },
        call.input as ShellInput,
        new Map(),
        onComputer,
      ),
    told: async () => {
      if (telling) await markComputerRebuildSeen(deps.db, call.botId, telling);
    },
  };
}

/**
 * The stored call of a feature's tool, such as a Connector tool: the features' tools listed afresh
 * (recorded activities), and the one it names. A Connection that is down now, or no longer offers
 * the tool, is the error.
 */
async function featureCall(
  deps: BotSdkContext,
  ctx: JobContext<CoreJobServices>,
  call: StoredCall,
  signal: AbortSignal,
): Promise<(() => Promise<unknown>) | { error: string }> {
  const features = await featureTools(
    deps,
    featureTurnOf({
      id: call.reviewId,
      userId: call.userId,
      botId: call.botId,
      conversationId: call.conversationId,
    }),
    // Run as it is: the user approved this very call, so it is never reviewed again.
    (_name, _toolCallId, run) => run(),
    new Set([shellToolName]),
    [],
    {
      signal,
      record: (featureId, list) => ctx.step(`${featureId}:tools`, list),
      computerCall: async () => ({ error: computerUnavailableError }),
    },
  );
  const tool = features.tools.find((each) => each.name === call.tool);
  const execute = tool?.execute;
  if (!execute) {
    return { error: features.missing(call.tool) ?? unavailableToolError(call.tool) };
  }
  return async () => {
    const result = await execute(call.input, { toolCallId: call.toolCallId } as never);
    const computer = deps.computer ? computerOf(deps, call.userId) : undefined;
    return capResult(
      result,
      spillPath(call.botId, call.toolCallId),
      computer && ((path, content) => computer.writeFile(path, content, { signal })),
    );
  };
}

/**
 * Wakes the Bot with the call's Approval Trigger, under its Conversation's row lock: once, since
 * its id comes from the review. A Bot deleted meanwhile wakes no one. Returns whether it woke.
 */
async function wakeWith(
  deps: BotSdkContext,
  tx: Transaction,
  call: StoredCall,
  result: unknown,
): Promise<boolean> {
  await lockConversation(tx, call.conversationId);
  const [kept] = await tx.select({ id: bot.id }).from(bot).where(eq(bot.id, call.botId));
  if (!kept) return false;
  const id = approvalTriggerId(call.reviewId);
  const [seen] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(eq(botTrigger.id, id));
  if (seen) return false;
  await receive(deps, tx, {
    id,
    conversationId: call.conversationId,
    source: "approval",
    channel: "web",
    text: approvalTriggerText(
      { id: call.reviewId, tool: call.tool, summary: call.summary },
      { result },
    ),
    receivedAt: deps.clock(),
  });
  return true;
}
