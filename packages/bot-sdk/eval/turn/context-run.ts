import { sendAndFollow } from "../../test/support/follow-send";
// One run of each step-8 eval (spec #665, #678), through the real `bot` and `memory` plugins: a
// fresh user and Bot, then the scenario. The cache eval plays a scripted Conversation and a warm
// and reads the usage rows; the Summary eval pushes a Conversation past the away Summary's input
// size, fast-forwards its job and asks about earlier facts; the tool search eval asks for a
// reminder, a Routine and a Helper check-up.

import { randomUUID } from "node:crypto";

import type { TokenUsage } from "@tanstack/ai";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import {
  botCheckIn,
  botHelper,
  botRoutine,
  botSummary,
  botTurn,
  message,
  usage,
} from "../../core/server/db/schema";
import type { Database } from "../../core/server/db/index";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { searchTextOf } from "../../core/shared/message-parts";
import { computerOf } from "../../plugins/bot/server/computer-tools";
import { lockConversation, receive } from "../../plugins/bot/server/router";
import { routineSnapshot } from "../../plugins/bot/server/routine";
import {
  awaySummaryKey,
  awaySummaryTokens,
  summarizeAwayJobName,
} from "../../plugins/bot/server/summary";
import { defaultTimeZone } from "../../plugins/bot/server/time-zone";
import { sendToUserToolName } from "../../plugins/bot/server/tool-names";
import { type WarmResult, warmBot } from "../../plugins/bot/server/warm";
import { profilePath } from "../../plugins/memory/server/bot-memory";
import { job } from "../../plugins/runner/server/db/job";
import {
  createFakeAdapter,
  type FakeAdapter,
  round,
  text,
  toolCall,
  withUsage,
} from "../../test/support/fake-adapter";
import { freshBot, seedHistory, type TurnEnv } from "./case";
import {
  cacheFakeReplies,
  cacheSteps,
  fakeSummaryProse,
  plantedFacts,
  summaryCriterion,
  summaryHistory,
  summaryQuestion,
  type ToolSearchCase,
} from "./context-cases";
import {
  type CacheCall,
  type ContextScore,
  rawCallsOf,
  scoreCache,
  scoreSummary,
  scoreToolSearch,
} from "./context-score";
import type { Complete } from "./queue-run";
import { judge } from "./queue-score";
import { turnIdOf } from "./routine-score";
import { waitForTurn } from "./routine-run";

/** Everything the three runs share. */
export type ContextEnv = {
  db: Database;
  sdk: TurnEnv["sdk"];
  /** The Bot's Model, a curated `"provider:model"`. */
  model: string;
  fake: boolean;
  /** The Model's API key in a real run. */
  apiKey: string | null;
  /** The fake Models by the API key of the run they play for. */
  adapters: Map<string, FakeAdapter["adapter"]>;
  complete: Complete;
};

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

export type ContextRunResult = {
  caseId: string;
  repeat: number;
  score: ContextScore;
  /** What the run saw, for the results file. */
  details: Record<string, unknown>;
  /** The judge's verdict and reason, `null` when the case has none. */
  judge: { correct: boolean; reason: string } | null;
  ms: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a Turn's memory pass, or the away Summary job, may take. */
const jobTimeoutMs = 5 * 60_000;

/** The memory pass a fake Model plays after each Turn: no changes. */
const fakePass = () => round(text(JSON.stringify({ ops: [] })));

/** A fake round's reported usage: the cache written on the first call of a run and read on the rest. */
function fakeUsage(first: boolean, input = 12_000, output = 20): TokenUsage {
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output,
    promptTokensDetails: first ? { cacheWriteTokens: input } : { cachedTokens: input },
  };
}

/** Waits until Turn `turnId`'s memory pass has ended, and throws when it failed or never came. */
async function passEnded(db: Database, turnId: string): Promise<void> {
  const key = `memory-pass:${turnId}`;
  const started = Date.now();
  while (Date.now() - started < jobTimeoutMs) {
    const [row] = await db
      .select({ status: job.status, lastError: job.lastError })
      .from(job)
      .where(and(eq(job.name, "memory.bot-pass"), eq(job.idempotencyKey, key)));
    if (row?.status === "succeeded") return;
    if (row?.status === "failed" || row?.status === "cancelled") {
      throw new Error(`the memory pass ${row.status}: ${row.lastError ?? "no error"}`);
    }
    // A Turn that ended queues its pass in the same transaction, so a missing row stays missing.
    if (!row && Date.now() - started > 5_000) throw new Error("no memory pass was queued");
    await sleep(250);
  }
  throw new Error("the memory pass did not end in time");
}

/** The newest Turn of `botId`, with its transcript. */
async function newestTurn(db: Database, botId: string) {
  const [turn] = await db
    .select({
      id: botTurn.id,
      status: botTurn.status,
      error: botTurn.error,
      transcript: botTurn.transcript,
    })
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(desc(botTurn.startedAt))
    .limit(1);
  if (!turn) throw new Error("The Bot has no Turn");
  return turn;
}

/** Sends a user Message and drains the stream; returns the Messages the Bot sent and how the Turn ended. */
async function userTurn(env: ContextEnv, ids: { userId: string; botId: string }, text: string) {
  const sent: string[] = [];
  let status: string = "stopped";
  for await (const event of await sendAndFollow(env.sdk, { ...ids, id: uuidv7(), text })) {
    if (event.type === "message" && event.message.role === "assistant")
      sent.push(event.message.text);
    if (event.type === "turnEnded") status = event.status;
  }
  const turn = await newestTurn(env.db, ids.botId);
  if (turn.error) throw new Error(`the Turn failed: ${turn.error}`);
  await passEnded(env.db, turn.id);
  return { sent, status, turn };
}

/** The key a run's Model is reached with: a fake one with its adapter registered, or the real key. */
function modelKeyFor(env: ContextEnv, caseId: string, rounds: () => Rounds): string | null {
  if (!env.fake) return env.apiKey;
  const key = `fake-${caseId}-${randomUUID()}`;
  env.adapters.set(key, createFakeAdapter({ rounds: rounds() }).adapter);
  return key;
}

/** A run's `TurnEnv`, with the key the run's Model is reached with. */
const turnEnvOf = (env: ContextEnv, key: string | null): TurnEnv => ({
  db: env.db,
  sdk: env.sdk,
  model: env.model,
  credentialsFor: () => (key === null ? null : { apiKey: key }),
});

/** Records an error as a failed run. */
function failed(
  caseId: string,
  repeat: number,
  started: number,
  caught: unknown,
): ContextRunResult {
  const error = caught instanceof Error ? caught.message : String(caught);
  return {
    caseId,
    repeat,
    score: { passed: false, reasons: [`error: ${error}`] },
    details: {},
    judge: null,
    ms: Date.now() - started,
    error,
  };
}

// ---- Cache stability --------------------------------------------------------------------------

/** The user's `turn` and `warm` usage rows, oldest first. */
async function cacheCalls(db: Database, userId: string): Promise<CacheCall[]> {
  const rows = await db
    .select({
      kind: usage.kind,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      promptHashes: usage.promptHashes,
    })
    .from(usage)
    .where(and(eq(usage.userId, userId), inArray(usage.kind, ["turn", "warm"])))
    .orderBy(asc(usage.createdAt), asc(usage.id));
  return rows.map((row) => ({ ...row, kind: row.kind as "turn" | "warm" }));
}

/**
 * Plays `cacheSteps`: user Messages, a memory change, a Routine's run and, last, a warm that is
 * due. Scores the usage rows (`scoreCache`).
 */
export async function runCacheCase(env: ContextEnv, repeat: number): Promise<ContextRunResult> {
  const started = Date.now();
  try {
    const key = modelKeyFor(env, "cache", () => {
      let turns = 0;
      return cacheSteps.flatMap((step) => {
        if (step.kind === "warm") return [withUsage(round(), fakeUsage(false, 12_000, 0))];
        if (step.kind === "memory") return [];
        const reply = cacheFakeReplies[turns]!;
        return [
          withUsage(
            round(toolCall({ name: sendToUserToolName, input: { text: reply, endTurn: true } })),
            fakeUsage(turns++ === 0),
          ),
          fakePass(),
        ];
      });
    });
    const { userId, bot, found } = await freshBot(turnEnvOf(env, key), "cache", repeat);
    const ids = { userId, botId: bot.id };
    const computer = computerOf(env.sdk, userId);
    let lastTurnId: string | undefined;
    let warm: WarmResult = { warmed: false, skipped: "nothing_cached" };
    for (const step of cacheSteps) {
      if (step.kind === "user") {
        lastTurnId = (await userTurn(env, ids, step.message)).turn.id;
      } else if (step.kind === "memory") {
        const path = profilePath(bot.id);
        const before = await computer.readFile(path);
        const existing = before ? new TextDecoder().decode(before) : "";
        await computer.writeFile(path, `${existing}- ${step.line}\n`);
      } else if (step.kind === "routine") {
        const now = new Date();
        await env.db.insert(botRoutine).values({
          id: uuidv7(),
          botId: bot.id,
          name: step.name,
          prompt: step.prompt,
          schedule: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "08:00" },
          timeZone: defaultTimeZone,
          state: "active",
          createdByTurnId: lastTurnId!,
          approvedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const taken = await env.db.transaction(async (tx) => {
          await lockConversation(tx, found!.conversationId);
          return receive(env.sdk, tx, {
            id: uuidv7(),
            conversationId: found!.conversationId,
            source: "routine",
            channel: "schedule",
            text: routineSnapshot({
              name: step.name,
              prompt: step.prompt,
              slot: now,
              timeZone: defaultTimeZone,
            }),
            receivedAt: now,
          });
        });
        env.sdk.runner.wake();
        const turnId = turnIdOf(taken);
        const ended = await waitForTurn(turnEnvOf(env, key), turnId);
        if (ended.status !== "complete")
          throw new Error(`the Routine's Turn ended ${ended.status}`);
        lastTurnId = turnId;
        await passEnded(env.db, turnId);
      } else {
        // The cache is due a warm once the Bot's last call is old: age the rows, as two hours passing would.
        await env.db
          .update(usage)
          .set({ createdAt: sql`${usage.createdAt} - interval '2 hours'` })
          .where(eq(usage.userId, userId));
        warm = await warmBot(env.sdk, userId, bot.id);
      }
    }
    const calls = await cacheCalls(env.db, userId);
    const score = scoreCache(calls, { readsCache: true, warmed: warm.warmed });
    if (!warm.warmed) score.reasons.push(`warmBot skipped: ${warm.skipped}`);
    return {
      caseId: "cache",
      repeat,
      score,
      details: { warm, calls },
      judge: null,
      ms: Date.now() - started,
    };
  } catch (caught) {
    return failed("cache", repeat, started, caught);
  }
}

// ---- Summary ----------------------------------------------------------------------------------

/** Waits for the Bot's first Summary row and returns its text and the time it covers until. */
async function summaryWritten(db: Database, botId: string) {
  const deadline = Date.now() + jobTimeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ text: botSummary.text, coversUntil: botSummary.coversUntil })
      .from(botSummary)
      .where(eq(botSummary.botId, botId))
      .orderBy(desc(botSummary.createdAt))
      .limit(1);
    if (row) return row;
    await sleep(500);
  }
  return null;
}

/**
 * Pushes a Conversation past the away Summary's input size: the planted facts, then filler notes,
 * then one Turn. That Turn queues the away Summary; the eval brings the job forward, waits for the
 * Summary, and asks for the planted facts in a new Turn. Scores the Summary's kept Messages and the
 * reply (`scoreSummary`), and the judge reads the reply.
 */
export async function runSummaryCase(env: ContextEnv, repeat: number): Promise<ContextRunResult> {
  const started = Date.now();
  try {
    const answers = plantedFacts.map((fact) => fact.answer);
    const key = modelKeyFor(env, "summary", () => [
      withUsage(
        round(
          toolCall({
            name: sendToUserToolName,
            input: { text: "All filed, nothing more from you.", endTurn: true },
          }),
        ),
        fakeUsage(true, awaySummaryTokens + 50_000),
      ),
      fakePass(),
      round(text(fakeSummaryProse)),
      round(
        toolCall({
          name: sendToUserToolName,
          input: {
            text: "Your dog is Biscuit, your flight is TP1347 and your budget is 2,400 euros.",
            endTurn: true,
          },
        }),
      ),
      fakePass(),
    ]);
    const { userId, bot, found } = await freshBot(turnEnvOf(env, key), "summary", repeat);
    const ids = { userId, botId: bot.id };
    await seedHistory(
      env.db,
      { botId: bot.id, conversationId: found!.conversationId },
      env.fake ? summaryHistory(3, 300) : summaryHistory(),
    );
    const first = await userTurn(
      env,
      ids,
      "Thanks for filing all of those. That's everything for today.",
    );
    const [queued] = await env.db
      .select({ id: job.id, status: job.status })
      .from(job)
      .where(
        and(eq(job.name, summarizeAwayJobName), eq(job.idempotencyKey, awaySummaryKey(bot.id))),
      );
    if (!queued) {
      const [last] = await env.db
        .select({ input: usage.inputTokens })
        .from(usage)
        .where(and(eq(usage.userId, userId), eq(usage.kind, "turn")))
        .orderBy(desc(usage.createdAt))
        .limit(1);
      throw new Error(
        `no away Summary was queued: the Turn's input was ${last?.input ?? "unknown"} tokens, the threshold is ${awaySummaryTokens}`,
      );
    }
    // The job waits 10 minutes after the Turn so the cache stays warm; the eval brings it forward.
    if (queued.status === "queued") {
      await env.db.update(job).set({ runAfter: new Date() }).where(eq(job.id, queued.id));
    }
    env.sdk.runner.wake();
    const summary = await summaryWritten(env.db, bot.id);

    // The Bot's last 3 Messages to the user up to the Summary, read from the Conversation itself.
    const keptRows = summary
      ? await env.db
          .select({ parts: message.parts })
          .from(message)
          .where(
            and(
              eq(message.conversationId, found!.conversationId),
              eq(message.role, "assistant"),
              lte(message.createdAt, summary.coversUntil),
            ),
          )
          .orderBy(desc(message.createdAt), desc(message.id))
          .limit(3)
      : [];
    const kept = keptRows.map((row) => searchTextOf(row.parts)).reverse();

    const second = await userTurn(env, ids, summaryQuestion);
    const [secondCall] = await env.db
      .select({ input: usage.inputTokens, read: usage.cacheReadTokens })
      .from(usage)
      .where(and(eq(usage.userId, userId), eq(usage.sourceId, second.turn.id)))
      .orderBy(asc(usage.createdAt))
      .limit(1);
    const score = scoreSummary({
      summaryText: summary?.text ?? null,
      kept,
      reply: second.sent,
      facts: answers,
      status: second.status,
    });
    const verdict = await judge(env.complete, {
      criterion: summaryCriterion,
      reply: second.sent.join("\n"),
    });
    return {
      caseId: "summary",
      repeat,
      score,
      details: {
        firstReply: first.sent,
        summary: summary?.text,
        kept,
        reply: second.sent,
        secondTurnInputTokens: secondCall?.input,
        secondTurnCacheReadTokens: secondCall?.read,
      },
      judge: verdict,
      ms: Date.now() - started,
    };
  } catch (caught) {
    return failed("summary", repeat, started, caught);
  }
}

// ---- Tool search ------------------------------------------------------------------------------

/** Whether the row that `evalCase.tool` should leave (or read) is there. */
async function rowThere(
  env: ContextEnv,
  botId: string,
  evalCase: ToolSearchCase,
  calls: ReturnType<typeof rawCallsOf>,
): Promise<boolean> {
  if (evalCase.tool === "set_check_in") {
    const rows = await env.db
      .select({ id: botCheckIn.id })
      .from(botCheckIn)
      .where(eq(botCheckIn.botId, botId));
    return rows.length > 0;
  }
  if (evalCase.tool === "create_routine") {
    const rows = await env.db
      .select({ id: botRoutine.id })
      .from(botRoutine)
      .where(eq(botRoutine.botId, botId));
    return rows.length > 0;
  }
  // A check-up writes no row: the right Helper's row is the one `check_helper` read back.
  return calls.some(
    (c) =>
      c.name === "run_tool" &&
      c.args.name === "check_helper" &&
      typeof c.result === "object" &&
      c.result !== null &&
      (c.result as { task?: unknown }).task === evalCase.helper?.task,
  );
}

/** Asks for one thing a deferred tool does; scores that the Bot loaded it and called it by name. */
export async function runToolSearchCase(
  env: ContextEnv,
  evalCase: ToolSearchCase,
  repeat: number,
): Promise<ContextRunResult> {
  const started = Date.now();
  try {
    const helperId = uuidv7();
    const args = evalCase.tool === "check_helper" ? { helperId } : evalCase.fakeArgs;
    const key = modelKeyFor(env, evalCase.id, () => [
      round(toolCall({ name: "describe_tool", input: { name: evalCase.tool } })),
      round(toolCall({ name: "run_tool", input: { name: evalCase.tool, args } })),
      round(
        toolCall({
          name: sendToUserToolName,
          input: { text: "Done.", endTurn: true },
        }),
      ),
      fakePass(),
    ]);
    const { userId, bot, found } = await freshBot(turnEnvOf(env, key), evalCase.id, repeat);
    await seedHistory(
      env.db,
      { botId: bot.id, conversationId: found!.conversationId },
      evalCase.history ?? [],
    );
    if (evalCase.helper) {
      const seeded = await newestTurn(env.db, bot.id);
      await env.db.insert(botHelper).values({
        id: helperId,
        botId: bot.id,
        type: "general",
        task: evalCase.helper.task,
        status: "running",
        startedByTurnId: seeded.id,
        startedAt: new Date(Date.now() - 5 * 60_000),
      });
    }
    const { sent, turn } = await userTurn(env, { userId, botId: bot.id }, evalCase.message);
    const calls = rawCallsOf(turn.transcript);
    const score = scoreToolSearch(
      evalCase.tool,
      calls,
      await rowThere(env, bot.id, evalCase, calls),
    );
    return {
      caseId: evalCase.id,
      repeat,
      score,
      details: { reply: sent, calls: calls.map((c) => ({ name: c.name, args: c.args })) },
      judge: null,
      ms: Date.now() - started,
    };
  } catch (caught) {
    return failed(evalCase.id, repeat, started, caught);
  }
}
