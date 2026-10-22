import { eq } from "drizzle-orm";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { bot, botTrigger, channelEmailAddress } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { lockConversation, receive } from "../../bot/server/router";
import { textParts } from "../../bot/server/store";
import { cancelTurn, hintChanged } from "../../bot/server/turn";
import { bareAddress, type EmailChannel, type InboundMail } from "./email";

/**
 * Takes one inbound request of the email Channel (spec #761). A mail the provider can't read gets
 * 400. Any other gets 202, and wakes the Bot whose address it was sent to only when its From is the
 * Bot's user's verified email (case-insensitive) and the provider's DMARC verdict is a pass. It
 * becomes Trigger `email:<Message-ID>`, carrying a new user Message on channel `email`, so a
 * redelivery makes none. Anything else is dropped silently and logged.
 */
export async function receiveEmail(
  sdk: BotSdkContext,
  {
    channel,
    verifiedEmail,
  }: { channel: EmailChannel; verifiedEmail: (userId: string) => Promise<string | null> },
  request: Request,
): Promise<Response> {
  const mail = await channel.provider.parseInbound(request);
  if ("rejected" in mail) return new Response(mail.rejected, { status: 400 });
  const dropped = await deliver(sdk, verifiedEmail, mail);
  if (dropped) sdk.logger.error(`Dropped an inbound email (${dropped})`, { to: mail.to });
  return new Response(null, { status: 202 });
}

/** Hands the Router the mail's Trigger; why it was dropped, or `null` once it was handed. */
async function deliver(
  sdk: BotSdkContext,
  verifiedEmail: (userId: string) => Promise<string | null>,
  mail: InboundMail,
): Promise<string | null> {
  const messageId = mail.messageId.trim().replace(/^<|>$/g, "");
  if (!messageId) return "no Message-ID";
  const owner = await botAt(sdk, mail.to);
  if (!owner) return "no Bot has the address";
  const verified = await verifiedEmail(owner.userId);
  if (!verified || bareAddress(mail.from) !== verified.trim().toLowerCase()) {
    return "the sender isn't the Bot's user";
  }
  if (mail.authentication.dmarc !== "pass") return "no DMARC pass";
  // The Quota and the Ban as for a webhook: read outside the transaction, and the mail is dropped.
  const call = await sdk.plugin("models").resolveModelCall(owner.userId, owner.model);
  if (!call) return "the Bot's Model isn't available";
  if (!(await call.meter.mayRun()).ok) return "the user's Quota is spent";
  if (await sdk.isUserBlocked(owner.userId)) return "the user is Banned";

  const id = `email:${messageId}`;
  const handed = await sdk.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in every transaction that hands the Router a Trigger.
    await lockConversation(tx, owner.conversationId);
    const [seen] = await tx
      .select({ id: botTrigger.id })
      .from(botTrigger)
      .where(eq(botTrigger.id, id));
    if (seen) return null;
    const now = sdk.clock();
    const row = await appendMessage(tx, owner.conversationId, {
      role: "user",
      parts: { ...textParts(mail.text.trim()), channel: "email" },
      status: "complete",
      createdAt: now,
    });
    const { waitsFor } = await receive(sdk, tx, {
      id,
      conversationId: owner.conversationId,
      source: "user",
      channel: "email",
      messageId: row.id,
      receivedAt: now,
    });
    // Like a web Message, it interrupts a running Turn, and the Turn that follows takes it.
    if (waitsFor) await cancelTurn(sdk, tx, waitsFor);
    return owner.conversationId;
  });
  if (!handed) return "a redelivery";
  sdk.plugin("runner").wake();
  await hintChanged(sdk, handed);
  return null;
}

/** The Bot whose address is one of `recipients`, if any. */
async function botAt(sdk: BotSdkContext, recipients: string[]) {
  for (const recipient of recipients) {
    const [row] = await sdk.db
      .select({ userId: bot.userId, conversationId: bot.conversationId, model: bot.model })
      .from(channelEmailAddress)
      .innerJoin(bot, eq(bot.id, channelEmailAddress.botId))
      .where(eq(channelEmailAddress.address, bareAddress(recipient)));
    if (row) return row;
  }
  return undefined;
}
