import { and, eq } from "drizzle-orm";

import {
  CredentialsRejectedError,
  type MessagingAdapter,
  type DeliveryPayload,
} from "../../channel/internal";
import type { BotSdkContext, Transaction } from "../../plugin";
import { PermanentJobError } from "../../runner/internal";
import { bot, channelAccount, linkedIdentity, message } from "../../storage";
import { listenerAccount, markNeedsAttention } from "./channel-accounts";
import { toBotMessage } from "./store";

/**
 * Where a Message of a Bot goes on messaging `platform` (spec #1044): the chat of the Bot's user's
 * Linked identity there, through the Bot's active Channel account. `null` when the user isn't
 * linked, or the Bot has no active account. `owner` names the Bot by its Conversation or its id.
 */
export async function messagingTarget(
  db: BotSdkContext["db"] | Transaction,
  owner: { conversationId: string } | { botId: string },
  platform: string,
): Promise<{ accountId: string; chatId: string } | null> {
  const [target] = await db
    .select({ accountId: channelAccount.id, chatId: linkedIdentity.platformUserId })
    .from(bot)
    .innerJoin(
      channelAccount,
      and(
        eq(channelAccount.botId, bot.id),
        eq(channelAccount.platform, platform),
        eq(channelAccount.status, "active"),
      ),
    )
    .innerJoin(
      linkedIdentity,
      and(eq(linkedIdentity.userId, bot.userId), eq(linkedIdentity.platform, platform)),
    )
    .where(
      "conversationId" in owner
        ? eq(bot.conversationId, owner.conversationId)
        : eq(bot.id, owner.botId),
    );
  return target ?? null;
}

/**
 * Sends one `channel.deliver` job's Message on its messaging Channel, as text through the adapter's
 * send (markup and splitting are the adapter's job). A Message or Bot deleted since, an unlinked
 * user or a removed or inactive Channel account sends nothing. The platform rejecting the credentials
 * marks the Channel account as needing attention and ends the job, which no retry fixes.
 */
export async function sendMessagingDelivery(
  deps: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  { platform, messageId }: Extract<DeliveryPayload, { channel: "messaging" }>,
): Promise<void> {
  const adapter = adapters.find((candidate) => candidate.id === platform);
  if (!adapter) throw new Error(`The channel plugin has no ${platform} adapter`);
  const [row] = await deps.db
    .select({
      id: message.id,
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt,
      botId: bot.id,
    })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(eq(message.id, messageId));
  if (!row) return;
  const target = await messagingTarget(deps.db, { botId: row.botId }, platform);
  if (!target) return;
  const text = toBotMessage(row).text;
  if (!text.trim()) return;
  const found = await listenerAccount(deps, target.accountId);
  if (!found?.account)
    throw new PermanentJobError("The Channel account's credentials can't be read");
  try {
    await adapter.send(found.account, { chatId: target.chatId, text }, { fetch: deps.fetch });
  } catch (error) {
    if (!(error instanceof CredentialsRejectedError)) throw error;
    await markNeedsAttention(deps, target.accountId, found.version, error.reason);
    throw new PermanentJobError(error.message);
  }
}
