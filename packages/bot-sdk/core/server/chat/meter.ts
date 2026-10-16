import type { TokenUsage } from "@tanstack/ai";

import type { MessageUsage } from "../../shared/chat/message-record";
import { usage as usageRows } from "../db/schema";
import type { AppDeps, HostImageModel, HostModel } from "../deps";
import { uuidv7 } from "../lib/uuidv7";
import type { UsageEvent } from "./hooks";
import { quotaRefusal } from "./quota";

/** What a Quota check answers: the call may run, or not until the window resets (ADR 0007). */
export type QuotaCheck = { ok: true } | { ok: false; resetsAt: Date };

/**
 * How one kind of paid call is checked against the Quota and recorded (ADR 0007). A credential
 * resolution gives one with the credentials: the free meter on the user's own key, or a Host meter
 * bound to the user, the Model or Tool, and its price.
 */
export type Meter<Usage> = {
  /** Whether the Host pays for the call, so the Quota applies. */
  readonly onHost: boolean;
  /**
   * The Quota check, before each call: a call on the user's own key always may run. Checked per
   * call, so a Run's later calls see the spend of its earlier ones.
   */
  mayRun(): Promise<QuotaCheck>;
  /**
   * Records what one call used: works out its cost, writes its `chat.usage` row and fires
   * `onUsage`. Never throws: a failed write goes to `deps.logger`.
   */
  record(usage: Usage): Promise<void>;
};

/** One call to a Model: a Run, a title, or one of a Memory job's calls. */
export type ModelUsage = {
  kind: "run" | "title" | "memory";
  usage: MessageUsage;
  /** The Provider's reported cost in USD, when it reported one for the whole call. */
  reportedCost?: number;
};
export type ModelMeter = Meter<ModelUsage>;

/** Web searches: each has a fixed price, so a search records only that it ran. */
export type SearchMeter = Meter<void>;

/** One `generate_image` call, as far as it got (spec #278). */
export type ImageCall = {
  /** Whether the request was sent to the Provider. */
  reached: boolean;
  /** Whether the Provider answered, and the usage it reported with the answer. */
  answered: boolean;
  usage?: TokenUsage;
  /** Whether the image was kept. */
  stored: boolean;
  /** Whether the Run was stopped during the call. */
  stopped: boolean;
};
export type ImageMeter = Meter<ImageCall>;

/** One transcription: the recording's own length, and the length the Provider reports, if any. */
export type TranscriptionMeter = Meter<{ durationSeconds: number; reportedSeconds?: number }>;

/** One embedding request: the characters it sent, and the tokens the Provider counted, if any. */
export type EmbeddingMeter = Meter<{ characters: number; reportedTokens?: number }>;

/** The meter of a call on the user's own key: never refused, never recorded. */
export const freeMeter: Meter<unknown> = {
  onHost: false,
  mayRun: async () => ({ ok: true }),
  record: async () => {},
};

type MeterDeps = Pick<AppDeps, "db" | "hooks" | "getQuota" | "logger">;

/** The fields of a usage row that a kind of call works out. */
type UsageRow = Pick<
  UsageEvent,
  "kind" | "model" | "inputTokens" | "outputTokens" | "costMicros" | "estimated"
>;

/**
 * A meter of `userId`'s calls. With `onHost`, `mayRun` checks the Quota. `rowOf` prices one call's
 * usage as its row, or answers `null` when the call records none.
 */
function meterOf<Usage>(
  deps: MeterDeps,
  userId: string,
  onHost: boolean,
  rowOf: (usage: Usage) => UsageRow | null,
): Meter<Usage> {
  return {
    onHost,
    mayRun: async () => {
      if (!onHost) return { ok: true };
      const refusal = await quotaRefusal(deps, userId);
      return refusal ? { ok: false, resetsAt: refusal.resetsAt } : { ok: true };
    },
    record: async (usage) => {
      const row = rowOf(usage);
      if (!row) return;
      // Set in app code, like the window the Quota sums (chat/quota.ts), so a fake clock agrees.
      const event: UsageEvent = { id: uuidv7(), userId, ...row, createdAt: new Date() };
      try {
        await deps.db.insert(usageRows).values(event);
      } catch (caught) {
        deps.logger.error(`Recording usage of a ${row.kind} for user ${userId} failed`, caught);
        return;
      }
      // The hook is never awaited (chat/hooks.ts).
      deps.hooks.fire("onUsage", event);
    },
  };
}

/** A Host Model's price, per 1M tokens (ADR 0007). */
export type HostPrice = Pick<HostModel, "inputUsdPerMillion" | "outputUsdPerMillion">;

/**
 * The cost of a call to a Host Model, in millionths of a US dollar (ADR 0007). The Provider's
 * reported cost wins when the call completed with one; otherwise the tokens summed (or estimated)
 * are priced. A price is per 1M tokens, so a token costs as many micros as its price.
 */
function modelCostMicros({ usage, reportedCost }: ModelUsage, price: HostPrice): number {
  if (!usage.estimated && reportedCost !== undefined) return Math.round(reportedCost * 1_000_000);
  return Math.round(
    usage.input * price.inputUsdPerMillion + usage.output * price.outputUsdPerMillion,
  );
}

/** The meter of calls to the Host Model `model` (`"provider:model"`) at its `price`. */
export function hostModelMeter(
  deps: MeterDeps,
  userId: string,
  model: string,
  price: HostPrice,
): ModelMeter {
  return meterOf(deps, userId, true, (call: ModelUsage) => ({
    kind: call.kind,
    model,
    inputTokens: call.usage.input,
    outputTokens: call.usage.output,
    costMicros: modelCostMicros(call, price),
    estimated: call.usage.estimated,
  }));
}

/** The meter of web searches on the Host's Tavily key, at its price per search. */
export function hostSearchMeter(
  deps: MeterDeps,
  userId: string,
  pricePerSearchUsd: number,
): SearchMeter {
  return meterOf<void>(deps, userId, true, () => ({
    kind: "web_search",
    model: "tavily",
    inputTokens: 0,
    outputTokens: 0,
    costMicros: Math.round(pricePerSearchUsd * 1_000_000),
    estimated: false,
  }));
}

/** A Host Image Model's price: flat per image, and per 1M tokens where the Provider reports tokens. */
export type ImagePrice = Pick<
  HostImageModel,
  "pricePerImageUsd" | "imageInputPerMTok" | "imageOutputPerMTok" | "textInputPerMTok"
>;

/**
 * Providers whose image adapter lets a Provider request run on after Stop (spec #278, #182). Only
 * Gemini-native, Cloudflare and Lovable cancel upstream, so Vercel Gateway runs on too.
 */
const imageCallsRunOnAfterStop = new Set([
  "openai",
  "grok",
  "openrouter",
  "byteplus",
  "vercel-gateway",
]);

/** Whether a call's usage says anything: a reported cost, or any tokens. */
function usageReported(usage: TokenUsage | undefined): usage is TokenUsage {
  return (
    usage !== undefined &&
    (usage.cost !== undefined || usage.promptTokens + usage.completionTokens > 0)
  );
}

/**
 * The cost of one image call, in micros and whether it is an estimate (ADR 0007, spec #278): the
 * reported cost if there is one; else the reported tokens at the Host's token prices, when it has
 * all three; else the flat `pricePerImageUsd`, estimated. A call stopped on an adapter that doesn't
 * cancel upstream is always the flat price, estimated, since the Provider billed it in full.
 */
function imageCostOf(
  price: ImagePrice | undefined,
  cancelsUpstream: boolean,
  { usage, stopped }: ImageCall,
): { costMicros: number; estimated: boolean } {
  if (!price) return { costMicros: 0, estimated: false };
  const flat = { costMicros: Math.round(price.pricePerImageUsd * 1_000_000), estimated: true };
  if (stopped && !cancelsUpstream) return flat;
  if (usage?.cost !== undefined)
    return { costMicros: Math.round(usage.cost * 1_000_000), estimated: false };
  const { imageInputPerMTok, textInputPerMTok, imageOutputPerMTok } = price;
  if (
    usageReported(usage) &&
    imageInputPerMTok !== undefined &&
    textInputPerMTok !== undefined &&
    imageOutputPerMTok !== undefined
  ) {
    const imageInput = usage.promptTokensDetails?.imageTokens ?? 0;
    const textInput = usage.promptTokensDetails?.textTokens ?? usage.promptTokens - imageInput;
    const micros =
      imageInput * imageInputPerMTok +
      textInput * textInputPerMTok +
      usage.completionTokens * imageOutputPerMTok;
    return { costMicros: Math.round(micros), estimated: false };
  }
  return flat;
}

/**
 * The meter of generated images on the Image Model `model` (`"provider:model"`, spec #278). `price`
 * is set on Host credentials only; unlike other calls, an image on the user's own key is recorded
 * too, with no Host cost.
 *
 * A Stop during the call on an adapter that doesn't cancel upstream is billed at the flat price,
 * estimated: the Provider runs the request on to the end. Otherwise a call bills when its image was
 * kept or the Provider reported usage (a stopped call on a cancelling adapter that already answered
 * with usage bills that usage); a refusal or error with no usage bills nothing.
 */
export function imageMeter(
  deps: MeterDeps,
  userId: string,
  { model, provider, price }: { model: string; provider: string; price?: ImagePrice },
): ImageMeter {
  const cancelsUpstream = !imageCallsRunOnAfterStop.has(provider);
  return meterOf(deps, userId, price !== undefined, (call: ImageCall) => {
    const billed =
      (call.stopped && call.reached && !cancelsUpstream) ||
      (call.answered && (call.stored || usageReported(call.usage)));
    if (!billed) return null;
    return {
      kind: "image",
      model,
      inputTokens: call.usage?.promptTokens ?? 0,
      outputTokens: call.usage?.completionTokens ?? 0,
      ...imageCostOf(price, cancelsUpstream, call),
    };
  });
}

/** Groq bills every request for at least this many seconds of audio. */
const groqMinimumSeconds = 10;

/**
 * The meter of transcriptions on the Host's transcription Model `model` (spec #249, ADR 0007). The
 * minutes are the length the Provider reports, else the recording's own length, which marks the row
 * estimated. Groq's minimum per request applies to either.
 */
export function hostTranscriptionMeter(
  deps: MeterDeps,
  userId: string,
  {
    provider,
    model,
    pricePerMinuteUsd,
  }: { provider: string; model: string; pricePerMinuteUsd: number },
): TranscriptionMeter {
  const minimum = provider === "groq" ? groqMinimumSeconds : 0;
  return meterOf(
    deps,
    userId,
    true,
    ({
      durationSeconds,
      reportedSeconds,
    }: {
      durationSeconds: number;
      reportedSeconds?: number;
    }) => {
      const seconds = Math.max(reportedSeconds ?? durationSeconds, minimum);
      return {
        kind: "transcription",
        model,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: Math.round((seconds / 60) * pricePerMinuteUsd * 1_000_000),
        estimated: reportedSeconds === undefined,
      };
    },
  );
}

/**
 * The meter of embedding requests on the Host's embedding Model `model` (ADR 0014). The tokens are
 * the Provider's count, or the characters ÷ 4 when the Provider reports none (Gemini), which marks
 * the row estimated.
 */
export function hostEmbeddingMeter(
  deps: MeterDeps,
  userId: string,
  { model, pricePerMillionTokensUsd }: { model: string; pricePerMillionTokensUsd: number },
): EmbeddingMeter {
  return meterOf(
    deps,
    userId,
    true,
    ({ characters, reportedTokens }: { characters: number; reportedTokens?: number }) => {
      const tokens = reportedTokens ?? Math.ceil(characters / 4);
      return {
        kind: "embedding",
        model,
        inputTokens: tokens,
        outputTokens: 0,
        costMicros: Math.round(tokens * pricePerMillionTokensUsd),
        estimated: reportedTokens === undefined,
      };
    },
  );
}
