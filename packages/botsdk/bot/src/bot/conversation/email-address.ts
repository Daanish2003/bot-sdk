import { eq } from "drizzle-orm";

import { rpcError } from "../../rpc-error";
import { channelEmailAddress } from "../../storage";
import type { BotSdkContext } from "../../plugin";
import { newEmailAddress } from "../../channel/internal";
import { findBot } from "./store";

/** The user's Bot `botId`, or `NOT_FOUND`. */
async function ownBot(sdk: BotSdkContext, userId: string, botId: string) {
  const found = await findBot(sdk.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  return found;
}

/** The user's Bot's email address on `domain`, made on the first read. */
export async function emailAddressOf(
  sdk: BotSdkContext,
  { userId, botId, domain }: { userId: string; botId: string; domain: string },
): Promise<string> {
  const found = await ownBot(sdk, userId, botId);
  // Two first reads at once both insert; the one that loses keeps the winner's address.
  await sdk.db
    .insert(channelEmailAddress)
    .values({ botId, address: newEmailAddress(found.name, domain), createdAt: sdk.clock() })
    .onConflictDoNothing({ target: channelEmailAddress.botId });
  const [row] = await sdk.db
    .select({ address: channelEmailAddress.address })
    .from(channelEmailAddress)
    .where(eq(channelEmailAddress.botId, botId));
  if (!row) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  return row.address;
}

/** Gives the user's Bot a new email address on `domain`; the old one stops at once. */
export async function rotateEmailAddress(
  sdk: BotSdkContext,
  { userId, botId, domain }: { userId: string; botId: string; domain: string },
): Promise<string> {
  const found = await ownBot(sdk, userId, botId);
  const address = newEmailAddress(found.name, domain);
  const [row] = await sdk.db
    .insert(channelEmailAddress)
    .values({ botId, address, createdAt: sdk.clock() })
    .onConflictDoUpdate({
      target: channelEmailAddress.botId,
      set: { address, createdAt: sdk.clock() },
    })
    .returning({ address: channelEmailAddress.address });
  if (!row) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  return row.address;
}
