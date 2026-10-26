import { eq } from "drizzle-orm";

import {
  deleteBlobsBestEffort,
  bot,
  botTrigger,
  channelEmailAddress,
} from "../../../../core/server/storage";
import { appendMessage } from "../../../../core/server/chat/message-tree";

import type { BotSdkContext } from "../../../../core/server/plugin";
import { sentFileBlobKey, storeMailFiles, textParts, hintChanged } from "../conversation";
import { lockConversation, receive } from "../triggers";

import { cancelTurn } from "./turn";
import { emailText } from "./email-text";
import { bareAddress, type EmailChannel, type InboundMail } from "../../../channel/server/internal";

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
  const dropped = await deliver(sdk, channel, verifiedEmail, mail);
  // A provider delivers at least once, so a redelivery is routine and goes unlogged, as is the
  // Bots' own outbound mail, which a local mail catcher posts back here.
  if (dropped && dropped !== redelivery && dropped !== ownMail)
    sdk.logger.error(`Dropped an inbound email (${dropped})`, { to: mail.to });
  return new Response(null, { status: 202 });
}

/** Why a mail already handed to the Router is dropped. */
const redelivery = "a redelivery";

/** Why a mail from a Bot's own address (the Channel's domain) is dropped. */
const ownMail = "a Bot's own mail";

/** Hands the Router the mail's Trigger; why it was dropped, or `null` once it was handed. */
async function deliver(
  sdk: BotSdkContext,
  channel: EmailChannel,
  verifiedEmail: (userId: string) => Promise<string | null>,
  mail: InboundMail,
): Promise<string | null> {
  if (bareAddress(mail.from).endsWith(`@${channel.domain}`)) return ownMail;
  // An out-of-office reply to the Bot's email would wake it, and its reply would be emailed again.
  if (isAutomatic(mail.headers)) return "an automatic reply";
  const messageId = mail.messageId.trim().replace(/^<|>$/g, "");
  if (!messageId) return "no Message-ID";
  const text = emailText(mail, channel.domain);
  if (!text) return "no text";
  const owner = await botAt(sdk, mail.to);
  if (!owner) return "no Bot has the address";
  const verified = await verifiedEmail(owner.userId);
  if (!verified || bareAddress(mail.from) !== verified.trim().toLowerCase()) {
    return "the sender isn't the Bot's user";
  }
  if (mail.authentication.dmarc !== "pass") return "no DMARC pass";
  // The Quota and the Ban as for a webhook: read outside the transaction, and the mail is dropped.
  const call = await sdk.models.resolveModelCall(owner.userId, owner.model);
  if (!call) return "the Bot's Model isn't available";
  if (!(await call.meter.mayRun()).ok) return "the user's Quota is spent";
  if (await sdk.isUserBlocked(owner.userId)) return "the user is Banned";

  // A redelivery is dropped before its attachments are downloaded and stored again.
  const [alreadySeen] = await sdk.db
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(eq(botTrigger.id, `email:${messageId}`));
  if (alreadySeen) return redelivery;

  // The owner's attachments go to the blob store like a composer's files; the others stay named.
  const { stored, unkept } = await storeMailFiles(sdk, mail.files ?? []);
  const body = emailText(
    { ...mail, attachments: mail.files ? unkept : mail.attachments },
    channel.domain,
  );
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
        parts: {
          schemaVersion: 1,
          parts: [
            ...(body ? textParts(body).parts : []),
            ...(stored.length
              ? [{ type: "control" as const, control: { kind: "files" as const, files: stored } }]
              : []),
          ],
          channel: "email",
          subject: mail.subject,
        },
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
    .catch(async (error: unknown) => {
      if (isTriggerIdClash(error)) return null;
      await deleteBlobsBestEffort(
        sdk,
        stored.map((file) => sentFileBlobKey(file.id)),
      );
      throw error;
    });
  if (handed === "rotated" || !handed) {
    // No Message holds the files, so their bytes go.
    await deleteBlobsBestEffort(
      sdk,
      stored.map((file) => sentFileBlobKey(file.id)),
    );
    return handed ? "no Bot has the address" : redelivery;
  }
  sdk.runner.wake();
  await hintChanged(sdk, handed);
  return null;
}

/**
 * Whether a mail says it was sent by a machine (RFC 3834's Auto-Submitted, and the older Precedence
 * and X-Autoreply headers), such as an out-of-office reply.
 */
function isAutomatic(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([name, value]) => {
    const header = name.toLowerCase();
    const said = value.trim().toLowerCase();
    if (header === "auto-submitted") return said !== "" && said !== "no";
    if (header === "precedence") return ["bulk", "junk", "list", "auto_reply"].includes(said);
    return header === "x-autoreply" || header === "x-autorespond";
  });
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
