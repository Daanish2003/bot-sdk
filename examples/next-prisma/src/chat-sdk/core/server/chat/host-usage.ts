import type { MessageUsage } from "../../shared/chat/message-record";
import { usage as usageRows } from "../db/schema/usage";
import type { AppDeps, HostModel } from "../deps";
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
