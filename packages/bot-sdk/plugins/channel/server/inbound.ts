import { eq } from "drizzle-orm";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { bot, botTrigger, channelEmailAddress } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { lockConversation, receive } from "../../bot/server/router";
import { textParts } from "../../bot/server/store";
import { cancelTurn, hintChanged } from "../../bot/server/turn";
import { emailText } from "./email-text";
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
  // A provider delivers at least once, so a redelivery is routine and goes unlogged.
  if (dropped && dropped !== redelivery)
    sdk.logger.error(`Dropped an inbound email (${dropped})`, { to: mail.to });
  return new Response(null, { status: 202 });
}

/** Why a mail already handed to the Router is dropped. */
const redelivery = "a redelivery";

/** Hands the Router the mail's Trigger; why it was dropped, or `null` once it was handed. */
async function deliver(
  sdk: BotSdkContext,
  verifiedEmail: (userId: string) => Promise<string | null>,
  mail: InboundMail,
): Promise<string | null> {
  const messageId = mail.messageId.trim().replace(/^<|>$/g, "");
  if (!messageId) return "no Message-ID";
  const text = emailText(mail);
  if (!text) return "no text";
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
  const handed = await sdk.db
    .transaction(async (tx) => {
      // The Conversation's row lock first, as in every transaction that hands the Router a Trigger.
      await lockConversation(tx, owner.conversationId);
      // Rotated since the lookup: the old address has stopped.
      const [current] = await tx
        .select({ botId: channelEmailAddress.botId })
        .from(channelEmailAddress)
        .where(eq(channelEmailAddress.address, owner.address));
      if (current?.botId !== owner.botId) return "rotated" as const;
      const [seen] = await tx
        .select({ id: botTrigger.id })
        .from(botTrigger)
        .where(eq(botTrigger.id, id));
      if (seen) return null;
      const now = sdk.clock();
      const row = await appendMessage(tx, owner.conversationId, {
        role: "user",
        parts: { ...textParts(text), channel: "email" },
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
    })
    // The same Message-ID handed in another Conversation's transaction meanwhile.
    .catch((error: unknown) => {
      if (isTriggerIdClash(error)) return null;
      throw error;
    });
  if (handed === "rotated") return "no Bot has the address";
  if (!handed) return redelivery;
  sdk.plugin("runner").wake();
  await hintChanged(sdk, handed);
  return null;
}

/** The Bot whose address is one of `recipients`, if any. */
async function botAt(sdk: BotSdkContext, recipients: string[]) {
  for (const recipient of recipients) {
    const [row] = await sdk.db
      .select({
        botId: bot.id,
        userId: bot.userId,
        conversationId: bot.conversationId,
        model: bot.model,
        address: channelEmailAddress.address,
      })
      .from(channelEmailAddress)
      .innerJoin(bot, eq(bot.id, channelEmailAddress.botId))
      .where(eq(channelEmailAddress.address, bareAddress(recipient)));
    if (row) return row;
  }
  return undefined;
}

/**
 * Whether Postgres refused the Trigger because its id is taken. The query layer wraps the driver's
 * error, so this follows the `cause` chain.
 */
function isTriggerIdClash(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (code === "23505" && constraint === "bot_trigger_pkey") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
