import {
  type AnyTextAdapter,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from "@tanstack/ai";
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";

import {
  bot,
  botCheckIn,
  botHelper,
  botRoutine,
  botTrigger,
  botTurn,
} from "../../../core/server/db/schema";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { withCacheControl } from "../../models/server/cache-control";
import { parseModelId } from "../../models/shared/models";
import { defineJob, type JobContext } from "../../runner/server/jobs/define";
import { computerOf } from "./computer-tools";
import { pruneScreenshots, resolveScreenshots } from "./desktop-tools";
import { callUsage } from "./loop";
import { latestPromptStartId, loopPromptStart } from "./prompt-start";
import { lockConversation, waitingIn } from "./router";
import { nextSlot } from "./schedule";
import {
  historyAfter,
  summarizeAwayJobName,
  summarizeInstruction,
  summaryOf,
  writeSummary,
} from "./summary";
import { awayStartParts, hintChanged } from "./turn";

/**
 * Background work due this soon wakes the Bot anyway, with its context still cached, so a Summary
 * then would do the work twice.
 */
const wakesSoonMs = 50 * 60_000;

/**
 * The Summary while away (slide 34), a delayed job queued 10 minutes after a big Turn and cancelled
 * by the next Turn's start. On the Bot's Model, whatever its Provider, it sends the current Prompt
 * start and history with the summarize instruction, so the call reads the cache, then commits the
 * Summary and a new Prompt start in one transaction, unless a Turn started since. Each step is a
 * Checkpoint, so a retry never calls the Model twice. The call is billed as soon as it returns, in
 * a transaction of its own, so a job cancelled by a Turn starting still pays for it.
 */
export const summarizeAwayJob = defineJob({
  name: summarizeAwayJobName,
  payload: z.object({ botId: z.uuid() }),
  run: ({ botId }, ctx) => summarizeAway(ctx.deps, botId, ctx),
});

/** What the job saw when it decided to summarize: the Bot, its newest Turn and its Prompt start. */
type Seen = {
  userId: string;
  conversationId: string;
  model: string;
  turnId: string;
  promptStartId: string;
};

async function summarizeAway(deps: BotSdkContext, botId: string, ctx: JobContext) {
  const seen = await ctx.activity("check", () => toSummarize(deps, botId));
  if (!seen) return;
  const models = deps.plugin("models");
  const call = await models.resolveModelCall(seen.userId, seen.model);
  if (!call) return;
  // On the user's own key or plan, the call is still recorded, at cost 0, as a Turn's are.
  const meter = call.meter.onHost ? call.meter : models.freeModelMeter(seen.userId, seen.model);
  const provider = parseModelId(seen.model)?.provider ?? "";

  const written = await ctx.activity("summary", async () => {
    if (!(await meter.mayRun()).ok) return null;
    const start = await loopPromptStart(deps.db, seen.promptStartId, async () => undefined);
    const history = await historyAfter(deps.db, botId, seen.promptStartId);
    const messages: ModelMessage[] = await resolveScreenshots(
      deps.blobStore,
      pruneScreenshots([
        { role: "user", content: start.firstMessage },
        ...history,
        { role: "user", content: summarizeInstruction },
      ]),
    );
    const base = models.adapterForCall(seen.model, call);
    // The Prompt start's own tool definitions and the Bot's cache key, as a Turn's calls send them.
    const adapter = {
      ...base,
      chatStream: (options: TextOptions) =>
        base.chatStream(
          withCacheControl(provider, `bot:${botId}`, {
            ...options,
            tools: start.tools as TextOptions["tools"],
          }),
        ),
    } as AnyTextAdapter;
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of chat({
        adapter,
        messages,
        systemPrompts: start.system.map((block) => block.text),
        abortController,
      })) {
        chunks.push(chunk);
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
    // A cut-off call records nothing: the cancelled job ends here.
    ctx.signal.throwIfAborted();
    const bill = callUsage(deps, provider, chunks, messages);
    if (bill) {
      const onUsage = await deps.db.transaction((tx) =>
        meter.recordIn(tx, {
          kind: "summary",
          usage: bill.usage,
          reportedCost: bill.reportedCost,
          sourceId: botId,
        }),
      );
      onUsage();
    }
    // The Model's own failure skips this Summary, as calling again would likely fail the same way.
    if (chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)) return null;
    const prose = chunks
      .map((chunk) => (chunk.type === EventType.TEXT_MESSAGE_CONTENT ? chunk.delta : ""))
      .join("");
    return { prose };
  });
  // A reply with no summary replaces nothing.
  if (!written?.prose.trim()) return;

  // The memory block as a Turn starting now reads it, for the new Prompt start.
  const memory = await ctx.activity("memory", () =>
    memoryNow(deps, botId, seen.userId, ctx.signal),
  );
  // And the Skills block, read the same way.
  const skills = await ctx.activity("skills", () =>
    skillsNow(deps, botId, seen.userId, ctx.signal),
  );
  // And the Knowledge block.
  const knowledge = await ctx.activity("knowledge", () =>
    knowledgeNow(deps, seen.userId, ctx.signal),
  );
  // Set only by a live write: a replayed one changed nothing, so hints nothing.
  let wrote = false;
  await ctx.activity("summary:write", async (tx) => {
    await lockConversation(tx, seen.conversationId);
    if (await turnedSince(tx, botId, seen)) return null;
    const now = deps.clock();
    const parts = await awayStartParts(
      deps,
      tx,
      {
        id: seen.turnId,
        botId,
        userId: seen.userId,
        conversationId: seen.conversationId,
        model: seen.model,
      },
      now,
      memory,
      skills,
      knowledge,
    );
    const id = await writeSummary(tx, { parts, prose: written.prose, kind: "away" });
    wrote = true;
    return id;
  });
  if (wrote) await hintChanged(deps, seen.conversationId);
}

/**
 * What the Bot's away Summary starts from, or `null` when it is skipped: the Bot is gone, has no
 * Turn or Prompt start yet, a Turn is running, its newest Turn is already summarized, or something
 * wakes it soon anyway (`wakesSoon`).
 */
async function toSummarize(deps: BotSdkContext, botId: string): Promise<Seen | null> {
  const [owner] = await deps.db
    .select({ userId: bot.userId, conversationId: bot.conversationId, model: bot.model })
    .from(bot)
    .where(eq(bot.id, botId));
  if (!owner) return null;
  const newest = await newestTurn(deps.db, botId);
  if (!newest || newest.status === "running") return null;
  const promptStartId = await latestPromptStartId(deps.db, botId);
  if (!promptStartId) return null;
  // Nothing happened since the current Summary. A mid-Turn one's Turn went on after it, so it may
  // have grown again.
  const summary = await summaryOf(deps.db, promptStartId);
  if (summary && (newest.endedAt ?? newest.startedAt) < summary.coversUntil) return null;
  if (await wakesSoon(deps, botId, owner.conversationId)) return null;
  return { ...owner, turnId: newest.id, promptStartId };
}

/** The Bot's newest Turn. */
async function newestTurn(db: BotSdkContext["db"] | Transaction, botId: string) {
  const [row] = await db
    .select({
      id: botTurn.id,
      status: botTurn.status,
      startedAt: botTurn.startedAt,
      endedAt: botTurn.endedAt,
    })
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(desc(botTurn.startedAt), desc(botTurn.id))
    .limit(1);
  return row;
}

/**
 * Whether background work is about to wake the Bot: a Helper running or waiting, a Trigger waiting
 * in its Conversation queue, or a Check-in or a scheduled Routine due within `wakesSoonMs`.
 */
async function wakesSoon(
  deps: BotSdkContext,
  botId: string,
  conversationId: string,
): Promise<boolean> {
  const now = deps.clock();
  const soon = new Date(now.getTime() + wakesSoonMs);
  const [[helper], [trigger], [checkIn], routines] = await Promise.all([
    deps.db
      .select({ id: botHelper.id })
      .from(botHelper)
      .where(and(eq(botHelper.botId, botId), inArray(botHelper.status, ["running", "waiting"])))
      .limit(1),
    deps.db
      .select({ id: botTrigger.id })
      .from(botTrigger)
      .where(waitingIn(conversationId))
      .limit(1),
    deps.db
      .select({ id: botCheckIn.id })
      .from(botCheckIn)
      .where(
        and(eq(botCheckIn.botId, botId), eq(botCheckIn.state, "pending"), lte(botCheckIn.at, soon)),
      )
      .limit(1),
    deps.db
      .select({ schedule: botRoutine.schedule, timeZone: botRoutine.timeZone })
      .from(botRoutine)
      .where(
        and(
          eq(botRoutine.botId, botId),
          eq(botRoutine.state, "active"),
          isNotNull(botRoutine.schedule),
        ),
      ),
  ]);
  if (helper || trigger || checkIn) return true;
  return routines.some((routine) => nextSlot(routine.schedule!, routine.timeZone, now) <= soon);
}

/** Whether a Turn started after the newest Turn the job saw, or its Prompt start was replaced. */
async function turnedSince(tx: Transaction, botId: string, seen: Seen): Promise<boolean> {
  const newest = await newestTurn(tx, botId);
  if (newest?.id !== seen.turnId) return true;
  return (await latestPromptStartId(tx, botId)) !== seen.promptStartId;
}

/**
 * The Bot's memory block as of now (ADR 0022), read through its Computer, or null with Memory off,
 * or when it can't be read, as a Turn carries on with none.
 */
async function memoryNow(
  deps: BotSdkContext,
  botId: string,
  userId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!deps.hasPlugin("computer") || !deps.hasPlugin("memory")) return null;
  try {
    return await deps.plugin("memory").botSnapshot({
      userId,
      botId,
      now: deps.clock(),
      computer: computerOf(deps, userId),
      signal,
    });
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

/**
 * The Bot's Skills block as of now (spec #713), read through its Computer, or null without the
 * `computer` or `skills` plugin, or when it can't be read, as a Turn carries on with none.
 */
async function skillsNow(
  deps: BotSdkContext,
  botId: string,
  userId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!deps.hasPlugin("computer") || !deps.hasPlugin("skills")) return null;
  const api = deps.plugin("skills");
  try {
    return api.prompt(
      botId,
      await api.botSkills({ botId, computer: computerOf(deps, userId), signal }),
    );
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

/**
 * The Knowledge block as of now (spec #737), read through the user's Computer, or null without
 * the `computer` or `knowledge` plugin, or when it can't be read, as a Turn carries on with none.
 */
async function knowledgeNow(
  deps: BotSdkContext,
  userId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!deps.hasPlugin("computer") || !deps.hasPlugin("knowledge")) return null;
  const api = deps.plugin("knowledge");
  try {
    return api.prompt(await api.readablePaths({ computer: computerOf(deps, userId), signal }));
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
