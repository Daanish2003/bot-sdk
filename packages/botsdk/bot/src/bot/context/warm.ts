import type { WarmResult } from "@botsdk/client/bot/contract";
import type { BotWarming } from "@botsdk/client/bot/turn";
import { parseModelId } from "@botsdk/client/models/models";
import {
  type AnyTextAdapter,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from "@tanstack/ai";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

import { botTurn, relations, usage } from "../../storage";
import type { Database } from "../../storage";
import type { BotSdkContext } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { withCacheControl, promptCharactersOf, reportedUsageOf } from "../../models/internal";

import { pruneScreenshots, resolveImageRefs, findBot, latestTurnStatus } from "../conversation";
import { latestPromptStart, loopPromptStart } from "./prompt-start";

import { historyAfter } from "./summary";

const minute = 60_000;

/** How long a Provider keeps a cached prompt (Anthropic's 1-hour breakpoints, OpenAI's 30 minutes). */
const cacheLifetimeMs = { anthropic: 60 * minute, openai: 30 * minute } as const;

/** A cache this close to expiring (or closer) is warmed again. */
const warmMarginMs = 5 * minute;

/**
 * A warm's Model call is aborted after this long, so a stalled Provider can't hold the Bot's warm
 * lock and a pool connection until a restart. A warm writes one token, so a normal one answers in
 * a few seconds; 45 s is well past that and well short of a Turn's wait.
 */
const warmTimeoutMs = 45_000;

export type { WarmResult, WarmSkipped } from "@botsdk/client/bot/contract";

/** The Provider of `model` when it has a warming call (slide 32): Anthropic, and OpenAI's GPT-5.6+. */
function warmableProvider(model: string): "anthropic" | "openai" | undefined {
  const parsed = parseModelId(model);
  if (parsed?.provider === "anthropic") return "anthropic";
  if (parsed?.provider !== "openai") return undefined;
  const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(parsed.modelId);
  const [major, minor] = [Number(version?.[1]), Number(version?.[2] ?? 0)];
  return major > 5 || (major === 5 && minor >= 6) ? "openai" : undefined;
}

/** The Drizzle instance over the connection holding a warm's lock; only its `$client` differs. */
const sessionDatabase = (client: pg.PoolClient) =>
  drizzle({ client, relations }) as unknown as Database;

/**
 * When the Bot last called its Model for a Turn or a warm: the newest of the user's `turn` rows of
 * the Bot's Turns and `warm` rows of the Bot, each read newest first on the user's
 * `(user_id, created_at)` index.
 */
async function lastCallAt(db: Database, userId: string, botId: string) {
  // One after the other: `db` may be a single connection.
  const turn = await db
    .select({ at: usage.createdAt })
    .from(usage)
    .innerJoin(botTurn, eq(sql`${botTurn.id}::text`, usage.sourceId))
    .where(and(eq(usage.userId, userId), eq(usage.kind, "turn"), eq(botTurn.botId, botId)))
    .orderBy(desc(usage.createdAt), desc(usage.id))
    .limit(1);
  const warm = await db
    .select({ at: usage.createdAt })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.kind, "warm"), eq(usage.sourceId, botId)))
    .orderBy(desc(usage.createdAt), desc(usage.id))
    .limit(1);
  const times = [turn[0]?.at, warm[0]?.at].filter((at) => at !== undefined);
  return times.length > 0 ? new Date(Math.max(...times.map((at) => at.getTime()))) : undefined;
}

/**
 * Warms the cache of one of the caller's Bots (slide 32): sends the Bot's stored Prompt start and
 * history, everything the next Turn sends before its newest message, with the Turn's own cache
 * controls and next to nothing to generate. Anthropic gets `max_tokens: 1`, which can bill one
 * output token (not 0: `@tanstack/ai-anthropic` refuses it before any request goes out, and
 * Anthropic refuses it on a streamed call, which this is), and OpenAI GPT-5.6+
 * `prompt_cache_options.prewarm`; the Provider bills the prompt as a cache write, recorded as a
 * `warm` call with the Bot as its source. It does nothing while a Turn runs, while the Bot's last
 * model call is within the cache lifetime minus 5 minutes, unless the Prompt start was built after
 * it (a Summary while away, which no call has cached yet), and for a Model with no warming call.
 * One warm at a time per Bot: a warm asked for while another runs skips as `still_warm`. A failed
 * call is logged and reported as `unavailable`. Another user's Bot is not found. No transaction is
 * open across the call (#1245), so an exclusive lock waits for no Model, and for no read of the warm's
 * on another connection.
 */
export async function warmBot(
  deps: BotSdkContext,
  userId: string,
  botId: string,
): Promise<WarmResult> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const provider = warmableProvider(found.model);
  if (!provider) return { warmed: false, skipped: "unsupported" };
  if ((await latestTurnStatus(deps.db, botId)) === "running") {
    return { warmed: false, skipped: "running" };
  }
  const start = await latestPromptStart(deps.db, botId);
  if (!start) return { warmed: false, skipped: "nothing_cached" };
  // Usage rows are stamped with the host's clock, so it is compared with that. A Prompt start
  // built after the last call (a Summary while away) has never been cached.
  const stillWarm = async (db: Database) => {
    const last = await lastCallAt(db, userId, botId);
    return (
      last !== undefined &&
      last >= start.builtAt &&
      Date.now() - last.getTime() < cacheLifetimeMs[provider] - warmMarginMs
    );
  };
  if (await stillWarm(deps.db)) return { warmed: false, skipped: "still_warm" };
  // Everything the call needs is read before the lock, so warms holding every connection of a pool
  // never wait for one more.
  const call = await preparedCall(
    deps,
    { userId, botId, conversationId: found.conversationId, model: found.model, provider },
    start.id,
  );
  if (typeof call === "string") return { warmed: false, skipped: call };
  // One warm at a time per Bot, from the check to the record: the lock is held until the warm's
  // row is saved, so a second tab that asks meanwhile skips, and one that asks after sees the row.
  return whileWarmLocked(deps, botId, async (session) => {
    // What it read may have moved on while it got ready and waited for a connection.
    if ((await latestTurnStatus(session, botId)) === "running") {
      return { warmed: false, skipped: "running" };
    }
    // A new Prompt start is left to the next warm, which reads it.
    if ((await latestPromptStart(session, botId))?.id !== start.id || (await stillWarm(session))) {
      return { warmed: false, skipped: "still_warm" };
    }
    const failure = await call(session);
    return failure ? { warmed: false, skipped: failure } : { warmed: true };
  });
}

/**
 * Runs `work` holding the Bot's warm lock, over the one connection that holds it, or skips as
 * `still_warm` when another warm holds it. The lock is a session's, with no transaction open, so it
 * holds no table's lock; like the Channel listeners' it needs a direct connection, not a
 * transaction-mode pooler. A connection that fails takes the lock with it, and is logged and not
 * handed back.
 */
async function whileWarmLocked(
  deps: BotSdkContext,
  botId: string,
  work: (session: Database) => Promise<WarmResult>,
): Promise<WarmResult> {
  const key = `warm:${botId}`;
  const session = await (deps.db.$client as pg.Pool).connect();
  let failed: Error | undefined;
  const onError = (error: Error) => {
    failed = error;
    deps.logger.error(`The warm lock's connection for Bot ${botId} failed`, error);
  };
  session.on("error", onError);
  try {
    const { rows } = await session.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [key],
    );
    if (!rows[0]?.locked) return { warmed: false, skipped: "still_warm" };
    try {
      return await work(sessionDatabase(session));
    } finally {
      try {
        const unlocked = await session.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
          [key],
        );
        if (!unlocked.rows[0]?.unlocked) onError(new Error("The lock was not held"));
      } catch (caught) {
        // Already logged if the connection reported it.
        if (!failed) onError(caught as Error);
      }
    }
  } finally {
    session.off("error", onError);
    session.release(failed);
  }
}

/**
 * The warming call itself, of Prompt start `startId` and the history after it, with all it reads
 * read: run with the warm's connection, on which its row is recorded, it answers why the call failed,
 * if it did. Or why no call can be made.
 */
async function preparedCall(
  deps: BotSdkContext,
  {
    userId,
    botId,
    conversationId,
    model,
    provider,
  }: {
    userId: string;
    botId: string;
    conversationId: string;
    model: string;
    provider: "anthropic" | "openai";
  },
  startId: string,
): Promise<
  "unsupported" | "unavailable" | ((session: Database) => Promise<"unavailable" | undefined>)
> {
  const models = deps.models;
  const call = await models.resolveModelCall(userId, model);
  // The plan caches nothing (probe #664), and a broken link has nothing to warm with.
  if (!call || call.linked) return "unsupported";
  const meter = call.meter.onHost ? call.meter : models.freeModelMeter(userId, model);
  if (!(await meter.mayRun()).ok) return "unavailable";

  const start = await loopPromptStart(deps.db, startId, async () => undefined);
  // From the latest Summary on, as the next Turn sends it.
  const history = await historyAfter(deps.db, { botId, conversationId }, startId);
  const messages: ModelMessage[] = await resolveImageRefs(
    deps.blobStore,
    pruneScreenshots([{ role: "user", content: start.firstMessage }, ...history]),
    { seesImages: (await models.resolveModel(userId, model))?.images ?? false },
  );

  const base = models.adapterForCall(model, call);
  const warming: Record<string, unknown> =
    provider === "anthropic" ? { max_tokens: 1 } : { prompt_cache_options: { prewarm: true } };
  // The Prompt start's own tool definitions go to the Model, as a Turn's calls send them.
  const adapter = {
    kind: "text",
    name: provider,
    model: parseModelId(model)?.modelId ?? model,
    chatStream: (options: TextOptions) => {
      const cached = withCacheControl(provider, `bot:${botId}`, {
        ...options,
        tools: start.tools as TextOptions["tools"],
      });
      return base.chatStream({
        ...cached,
        modelOptions: { ...(cached.modelOptions as object | undefined), ...warming },
      });
    },
  } as unknown as AnyTextAdapter;

  return async (session) => {
    let finished: StreamChunk[];
    const abortController = new AbortController();
    const timeout = AbortSignal.timeout(warmTimeoutMs);
    const onTimeout = () => abortController.abort(timeout.reason);
    timeout.addEventListener("abort", onTimeout, { once: true });
    try {
      const chunks: StreamChunk[] = [];
      // Raced with the abort too: a stalled Provider may never end its stream, abort or not.
      const stopped = new Promise<never>((_, reject) =>
        abortController.signal.addEventListener("abort", () => reject(timeout.reason), {
          once: true,
        }),
      );
      stopped.catch(() => {});
      await Promise.race([
        stopped,
        (async () => {
          for await (const chunk of chat({
            adapter,
            threadId: botId,
            messages,
            systemPrompts: start.system.map((block) => block.text),
            abortController,
          })) {
            chunks.push(chunk);
          }
        })(),
      ]);
      // A warm stops at its one token, so Anthropic ends it `max_tokens`, with the usage it billed.
      // Whatever that token began is dropped with these chunks.
      finished = chunks.map((chunk) =>
        chunk.type === EventType.RUN_ERROR && chunk.code === "max_tokens" && chunk.usage
          ? ({ ...chunk, type: EventType.RUN_FINISHED } as unknown as StreamChunk)
          : chunk,
      );
      const failed = finished.find((chunk) => chunk.type === EventType.RUN_ERROR);
      if (failed) throw new Error(failed.message);
    } catch (caught) {
      deps.logger.error(`Warming the cache of Bot ${botId} failed`, caught);
      return "unavailable";
    } finally {
      timeout.removeEventListener("abort", onTimeout);
    }
    const reported = reportedUsageOf(finished);
    const row = {
      kind: "warm" as const,
      sourceId: botId,
      usage: models.messageUsage(reported.usage, {
        promptCharacters: promptCharactersOf(messages),
        parts: [],
      }),
      reportedCost: reported.cost,
    };
    // On the connection already held, so no wait for a free one. The call is made, so when that
    // fails the row goes through the pool, where `record` logs a failure and never fails the warm.
    let fire: () => void;
    try {
      fire = await session.transaction((tx) => meter.recordIn(tx, row));
    } catch (caught) {
      deps.logger.error(`Recording the warm of Bot ${botId} on its connection failed`, caught);
      await meter.record(row);
      return undefined;
    }
    fire();
    return undefined;
  };
}

/** The Bot's warming calls, oldest first, for the muted lines in its thread. */
export async function botWarmings(
  deps: Pick<BotSdkContext, "db">,
  userId: string,
  botId: string,
): Promise<BotWarming[]> {
  return deps.db
    .select({ id: usage.id, at: usage.createdAt, costMicros: usage.costMicros })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.kind, "warm"), eq(usage.sourceId, botId)))
    .orderBy(asc(usage.createdAt), asc(usage.id));
}
