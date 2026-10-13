import type { TokenUsage } from "@tanstack/ai";

import type { MessageUsage } from "../../shared/chat/message-record";
import { usage as usageRows } from "../db/schema/usage";
import type { AppDeps, HostImageModel, HostModel } from "../deps";
import { uuidv7 } from "../lib/uuidv7";

/** A Host Model's price, per 1M tokens (ADR 0007). */
export type HostPrice = Pick<HostModel, "inputUsdPerMillion" | "outputUsdPerMillion">;

/** A Run on Host credentials: whose Quota it counts against, and what the Model costs. */
export type UsageMeter = { userId: string; model: string; price: HostPrice };

/**
 * The cost of a Run on Host credentials, in millionths of a US dollar (ADR 0007). The Provider's
 * reported cost wins when the Run completed with one; otherwise the tokens #117 summed (or
 * estimated) are priced. A price is per 1M tokens, so a token costs as many micros as its price.
 */
export function runCostMicros(
  usage: MessageUsage,
  reportedCost: number | undefined,
  price: HostPrice,
): number {
  if (!usage.estimated && reportedCost !== undefined) return Math.round(reportedCost * 1_000_000);
  return Math.round(
    usage.input * price.inputUsdPerMillion + usage.output * price.outputUsdPerMillion,
  );
}

/** Writes the `chat.usage` row of a call on Host credentials for a Run or a title (ADR 0007). */
export async function recordHostUsage(
  deps: Pick<AppDeps, "db">,
  kind: "run" | "title",
  meter: UsageMeter,
  usage: MessageUsage,
  reportedCost: number | undefined,
): Promise<void> {
  await deps.db.insert(usageRows).values({
    id: uuidv7(),
    userId: meter.userId,
    kind,
    model: meter.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    costMicros: runCostMicros(usage, reportedCost, meter.price),
    estimated: usage.estimated,
    // Set in app code, like the window the Quota sums (chat/quota.ts), so a fake clock agrees.
    createdAt: new Date(),
  });
}

/** The Host's Tool a web search runs on, and what each search costs (ADR 0007). */
export type SearchMeter = { userId: string; pricePerSearchUsd: number };

/** Writes the `chat.usage` row of one web search on Host credentials, at its fixed price. */
export async function recordSearchUsage(
  deps: Pick<AppDeps, "db">,
  meter: SearchMeter,
): Promise<void> {
  await deps.db.insert(usageRows).values({
    id: uuidv7(),
    userId: meter.userId,
    kind: "web_search",
    model: "tavily",
    inputTokens: 0,
    outputTokens: 0,
    costMicros: Math.round(meter.pricePerSearchUsd * 1_000_000),
    estimated: false,
    createdAt: new Date(),
  });
}

/** A Host Image Model's price: flat per image, and per 1M tokens where the Provider reports tokens. */
export type ImagePrice = Pick<
  HostImageModel,
  "pricePerImageUsd" | "imageInputPerMTok" | "imageOutputPerMTok" | "textInputPerMTok"
>;

/**
 * One generated image's call (spec #278). `price` is set on Host credentials only: a BYOK call
 * records its usage with no Host cost. `cancelsUpstream` is whether a Stop cancels the Provider's
 * request for the image (see `imageCancelsUpstream`).
 */
export type ImageMeter = {
  userId: string;
  /** The Image Model's `"provider:model"` id, which the usage row records. */
  model: string;
  price?: ImagePrice;
  cancelsUpstream: boolean;
};

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

/** Whether a Stop cancels the Provider's request for an image on `provider`. */
export function imageCancelsUpstream(provider: string): boolean {
  return !imageCallsRunOnAfterStop.has(provider);
}

/** Whether a call's usage says anything: a reported cost, or any tokens. */
export function usageReported(usage: TokenUsage | undefined): usage is TokenUsage {
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
  meter: ImageMeter,
  usage: TokenUsage | undefined,
  stopped: boolean,
): { costMicros: number; estimated: boolean } {
  const { price } = meter;
  if (!price) return { costMicros: 0, estimated: false };
  const flat = { costMicros: Math.round(price.pricePerImageUsd * 1_000_000), estimated: true };
  if (stopped && !meter.cancelsUpstream) return flat;
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
 * Writes the `chat.usage` row of one generated image (spec #278): `usage` is what the Provider
 * reported for the call, if it did. `stopped` is set when the Run was stopped during the call.
 */
export async function recordImageUsage(
  deps: Pick<AppDeps, "db">,
  meter: ImageMeter,
  usage: TokenUsage | undefined,
  stopped: boolean,
): Promise<void> {
  const cost = imageCostOf(meter, usage, stopped);
  await deps.db.insert(usageRows).values({
    id: uuidv7(),
    userId: meter.userId,
    kind: "image",
    model: meter.model,
    inputTokens: usage?.promptTokens ?? 0,
    outputTokens: usage?.completionTokens ?? 0,
    costMicros: cost.costMicros,
    estimated: cost.estimated,
    createdAt: new Date(),
  });
}
