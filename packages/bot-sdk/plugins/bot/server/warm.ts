import {
  type AnyTextAdapter,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from "@tanstack/ai";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { botPromptStart, botTurn, usage } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { withCacheControl } from "../../models/server/cache-control";
import type { BotWarming } from "../shared/turn";
import { promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import { parseModelId } from "../../models/shared/models";
import { pruneScreenshots, resolveScreenshots } from "./desktop-tools";
import { loopPromptStart } from "./prompt-start";
import { findBot, latestTurnStatus } from "./store";
import { historyAfter } from "./summary";

const minute = 60_000;

/** How long a Provider keeps a cached prompt (Anthropic's 1-hour breakpoints, OpenAI's 30 minutes). */
const cacheLifetimeMs = { anthropic: 60 * minute, openai: 30 * minute } as const;

/** A cache this close to expiring (or closer) is warmed again. */
const warmMarginMs = 5 * minute;

/** Why a warm did nothing; `warmed` is false with one of these. */
export type WarmSkipped =
  /** A Turn is running, which keeps the cache warm itself. */
  | "running"
  /** The Bot has no Prompt start yet: nothing is cached. */
  | "nothing_cached"
  /** The Bot's last model call is recent enough that the cache is still warm. */
  | "still_warm"
  /** The Model has no warming call: Gemini, the ChatGPT plan, and the other Providers. */
  | "unsupported"
  /** The Quota is used up, or the call failed. */
  | "unavailable";

export type WarmResult = { warmed: true } | { warmed: false; skipped: WarmSkipped };

/** The Provider of `model` when it has a warming call (slide 32): Anthropic, and OpenAI's GPT-5.6+. */
function warmableProvider(model: string): "anthropic" | "openai" | undefined {
  const parsed = parseModelId(model);
  if (parsed?.provider === "anthropic") return "anthropic";
  if (parsed?.provider !== "openai") return undefined;
  const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(parsed.modelId);
  const [major, minor] = [Number(version?.[1]), Number(version?.[2] ?? 0)];
  return major > 5 || (major === 5 && minor >= 6) ? "openai" : undefined;
}

/**
 * When the Bot last called its Model for a Turn or a warm: the newest of the user's `turn` rows of
 * the Bot's Turns and `warm` rows of the Bot, each read newest first on the user's
 * `(user_id, created_at)` index.
 */
async function lastCallAt(db: Database | Transaction, userId: string, botId: string) {
  const [turn, warm] = await Promise.all([
    db
      .select({ at: usage.createdAt })
      .from(usage)
      .innerJoin(botTurn, eq(sql`${botTurn.id}::text`, usage.sourceId))
      .where(and(eq(usage.userId, userId), eq(usage.kind, "turn"), eq(botTurn.botId, botId)))
      .orderBy(desc(usage.createdAt), desc(usage.id))
      .limit(1),
    db
      .select({ at: usage.createdAt })
      .from(usage)
      .where(and(eq(usage.userId, userId), eq(usage.kind, "warm"), eq(usage.sourceId, botId)))
      .orderBy(desc(usage.createdAt), desc(usage.id))
      .limit(1),
  ]);
  const times = [turn[0]?.at, warm[0]?.at].filter((at) => at !== undefined);
  return times.length > 0 ? new Date(Math.max(...times.map((at) => at.getTime()))) : undefined;
}

/**
 * Warms the cache of one of the caller's Bots (slide 32): sends the Bot's stored Prompt start and
 * history, everything the next Turn sends before its newest message, with the Turn's own cache
 * controls and nothing to generate. Anthropic gets `max_tokens: 0`, and OpenAI GPT-5.6+
 * `prompt_cache_options.prewarm`; the Provider bills the prompt as a cache write, recorded as a
 * `warm` call with the Bot as its source. It does nothing while a Turn runs, while the Bot's last
 * model call is within the cache lifetime minus 5 minutes, unless the Prompt start was built after
 * it (a Summary while away, which no call has cached yet), and for a Model with no warming call.
 * One warm at a time per Bot: a warm asked for while another runs skips as `still_warm`. A failed
 * call is logged and reported as `unavailable`. Another user's Bot is not found.
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
  // One warm at a time per Bot, from the check to the record: the lock is held until the warm's
  // row commits, so a second tab that asks meanwhile skips, and one that asks after sees the row.
  let fire: (() => void) | undefined;
  const result = await deps.db.transaction(async (tx): Promise<WarmResult> => {
    const locked = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`warm:${botId}`}, 0)) as locked`,
    );
    if (!locked.rows[0]?.locked) return { warmed: false, skipped: "still_warm" };
    const [start] = await tx
      .select({ id: botPromptStart.id, builtAt: botPromptStart.builtAt })
      .from(botPromptStart)
      .where(eq(botPromptStart.botId, botId))
      .orderBy(desc(botPromptStart.builtAt), desc(botPromptStart.id))
      .limit(1);
    if (!start) return { warmed: false, skipped: "nothing_cached" };
    // Usage rows are stamped with the host's clock, so it is compared with that. A Prompt start
    // built after the last call (a Summary while away) has never been cached.
    const last = await lastCallAt(tx, userId, botId);
    if (
      last &&
      last >= start.builtAt &&
      Date.now() - last.getTime() < cacheLifetimeMs[provider] - warmMarginMs
    ) {
      return { warmed: false, skipped: "still_warm" };
    }
    const warmed = await warmCall(
      deps,
      tx,
      { userId, botId, model: found.model, provider },
      start.id,
    );
    if (typeof warmed === "string") return { warmed: false, skipped: warmed };
    fire = warmed;
    return { warmed: true };
  });
  fire?.();
  return result;
}

/**
 * The warming call itself, of Prompt start `startId` and the history after it, recorded in `tx`.
 * Returns the `onUsage` firing, for once `tx` has committed, or why it made no call.
 */
async function warmCall(
  deps: BotSdkContext,
  tx: Transaction,
  {
    userId,
    botId,
    model,
    provider,
  }: { userId: string; botId: string; model: string; provider: "anthropic" | "openai" },
  startId: string,
): Promise<(() => void) | "unsupported" | "unavailable"> {
  const models = deps.plugin("models");
  const call = await models.resolveModelCall(userId, model);
  // The plan caches nothing (probe #664), and a broken link has nothing to warm with.
  if (!call || call.linked) return "unsupported";
  const meter = call.meter.onHost ? call.meter : models.freeModelMeter(userId, model);
  if (!(await meter.mayRun()).ok) return "unavailable";

  const start = await loopPromptStart(tx, startId, async () => undefined);
  // From the latest Summary on, as the next Turn sends it.
  const history = await historyAfter(tx, botId, startId);
  const messages: ModelMessage[] = await resolveScreenshots(
    deps.blobStore,
    pruneScreenshots([{ role: "user", content: start.firstMessage }, ...history]),
  );

  const base = models.adapterForCall(model, call);
  const warming: Record<string, unknown> =
    provider === "anthropic" ? { max_tokens: 0 } : { prompt_cache_options: { prewarm: true } };
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

  let finished: StreamChunk[];
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of chat({
      adapter,
      messages,
      systemPrompts: start.system.map((block) => block.text),
    })) {
      chunks.push(chunk);
    }
    // A warm generates nothing, so Anthropic ends it `max_tokens`, with the usage it billed.
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
  }
  const reported = reportedUsageOf(provider, finished);
  return meter.recordIn(tx, {
    kind: "warm",
    sourceId: botId,
    usage: models.messageUsage(reported.usage, {
      promptCharacters: promptCharactersOf(messages),
      parts: [],
    }),
    reportedCost: reported.cost,
  });
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
