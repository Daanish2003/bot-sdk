import { eq } from "drizzle-orm";

import { memorySettings } from "./db/settings";
import type { BotSdkContext, Transaction } from "@botsdk/bot/plugin";

/** What the Memory switch shows: the switch, and whether Bots can have memory. */
import type { MemoryStatus } from "../shared/contract";

export type { MemoryStatus };

/** The user's Memory switch: on for a user who never saved it. */
export async function memoryEnabledFor(
  deps: { db: Pick<Transaction, "select"> },
  userId: string,
): Promise<boolean> {
  const [settings] = await deps.db
    .select({ enabled: memorySettings.enabled })
    .from(memorySettings)
    .where(eq(memorySettings.userId, userId));
  return settings?.enabled ?? true;
}

/** The user's Memory switch, and whether Bots can have memory. */
export async function memoryStatus(deps: BotSdkContext, userId: string): Promise<MemoryStatus> {
  return {
    enabled: await memoryEnabledFor(deps, userId),
    botMemoryAvailable: Boolean(deps.computer),
  };
}

/** Saves the "Use and make Memories" switch. Off keeps every memory file; it only stops using and making them. */
export async function setMemoryEnabled(deps: BotSdkContext, userId: string, enabled: boolean) {
  await deps.db
    .insert(memorySettings)
    .values({ userId, enabled })
    .onConflictDoUpdate({ target: memorySettings.userId, set: { enabled } });
}
