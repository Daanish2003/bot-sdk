import {
  type AnyTextAdapter,
  chat,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from "@tanstack/ai";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { botTurn, usage } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { withCacheControl } from "../../models/server/cache-control";
import type { BotWarming } from "../shared/turn";
import { promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import { parseModelId } from "../../models/shared/models";
import { pruneScreenshots, resolveScreenshots } from "./desktop-tools";
import { latestPromptStartId, loopPromptStart } from "./prompt-start";
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
async function lastCallAt(deps: BotSdkContext, userId: string, botId: string) {
  const [turn, warm] = await Promise.all([
    deps.db
      .select({ at: usage.createdAt })
      .from(usage)
      .innerJoin(botTurn, eq(sql`${botTurn.id}::text`, usage.sourceId))
      .where(and(eq(usage.userId, userId), eq(usage.kind, "turn"), eq(botTurn.botId, botId)))
      .orderBy(desc(usage.createdAt), desc(usage.id))
      .limit(1),
    deps.db
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
 * model call is within the cache lifetime minus 5 minutes, and for a Model with no warming call. A
 * failed call is logged and reported as `unavailable`. Another user's Bot is not found.
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
  const startId = await latestPromptStartId(deps.db, botId);
  if (!startId) return { warmed: false, skipped: "nothing_cached" };
  // Usage rows are stamped with the host's clock, so it is compared with that.
  const last = await lastCallAt(deps, userId, botId);
  if (last && Date.now() - last.getTime() < cacheLifetimeMs[provider] - warmMarginMs) {
    return { warmed: false, skipped: "still_warm" };
  }

  const models = deps.plugin("models");
  const call = await models.resolveModelCall(userId, found.model);
  // The plan caches nothing (probe #664), and a broken link has nothing to warm with.
  if (!call || call.linked) return { warmed: false, skipped: "unsupported" };
  const meter = call.meter.onHost ? call.meter : models.freeModelMeter(userId, found.model);
  if (!(await meter.mayRun()).ok) return { warmed: false, skipped: "unavailable" };

  const start = await loopPromptStart(deps.db, startId, async () => undefined);
  // From the latest Summary on, as the next Turn sends it.
  const history = await historyAfter(deps.db, botId, startId);
  const messages: ModelMessage[] = await resolveScreenshots(
    deps.blobStore,
    pruneScreenshots([{ role: "user", content: start.firstMessage }, ...history]),
  );

  const base = models.adapterForCall(found.model, call);
  const warming: Record<string, unknown> =
    provider === "anthropic" ? { max_tokens: 0 } : { prompt_cache_options: { prewarm: true } };
  // The Prompt start's own tool definitions go to the Model, as a Turn's calls send them.
  const adapter = {
    kind: "text",
    name: provider,
    model: parseModelId(found.model)?.modelId ?? found.model,
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
    const finished = chunks.map((chunk) =>
      chunk.type === EventType.RUN_ERROR && chunk.code === "max_tokens" && chunk.usage
        ? ({ ...chunk, type: EventType.RUN_FINISHED } as unknown as StreamChunk)
        : chunk,
    );
    const failed = finished.find((chunk) => chunk.type === EventType.RUN_ERROR);
    if (failed) throw new Error(failed.message);
    const reported = reportedUsageOf(provider, finished);
    await meter.record({
      kind: "warm",
      sourceId: botId,
      usage: models.messageUsage(reported.usage, {
        promptCharacters: promptCharactersOf(messages),
        parts: [],
      }),
      reportedCost: reported.cost,
    });
    return { warmed: true };
  } catch (caught) {
    deps.logger.error(`Warming the cache of Bot ${botId} failed`, caught);
    return { warmed: false, skipped: "unavailable" };
  }
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
