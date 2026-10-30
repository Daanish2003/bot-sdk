import { asc, eq } from "drizzle-orm";

import type { Transaction, UserDeleteHooks } from "../../plugin";
import { bot, channelAccount, linkCode, linkedIdentity } from "../../storage";

/*
 * The `channel` plugin's part of a user's delete and export (spec #1044): the user's Linked
 * identities and link codes, and the handles of their Bots' Channel accounts, never credentials.
 */

/** Deletes the user's Linked identities and link codes. Their Channel accounts go with their Bots. */
export const channelUserDelete: UserDeleteHooks<void> = {
  before: async (_sdk, { userId, tx }) => {
    await tx.delete(linkedIdentity).where(eq(linkedIdentity.userId, userId));
    await tx.delete(linkCode).where(eq(linkCode.userId, userId));
  },
  after: async () => {},
};

/** The user's Linked identities and their Bots' Channel accounts as the export holds them. */
export async function exportChannelData(tx: Transaction, userId: string) {
  const identities = await tx
    .select({
      platform: linkedIdentity.platform,
      platformUserId: linkedIdentity.platformUserId,
      handle: linkedIdentity.handle,
      workspaceId: linkedIdentity.workspaceId,
      linkedAt: linkedIdentity.linkedAt,
    })
    .from(linkedIdentity)
    .where(eq(linkedIdentity.userId, userId))
    .orderBy(asc(linkedIdentity.platform));
  // Columns are picked one by one, so the encrypted credentials can't leak into the export.
  const accounts = await tx
    .select({
      botId: channelAccount.botId,
      platform: channelAccount.platform,
      handle: channelAccount.handle,
      status: channelAccount.status,
      createdAt: channelAccount.createdAt,
    })
    .from(channelAccount)
    .innerJoin(bot, eq(bot.id, channelAccount.botId))
    .where(eq(bot.userId, userId))
    .orderBy(asc(channelAccount.botId), asc(channelAccount.platform));
  return { identities, accounts };
}
