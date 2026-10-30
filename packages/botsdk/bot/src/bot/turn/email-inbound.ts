import { eq } from "drizzle-orm";

import { bot, botTrigger, channelEmailAddress } from "../../storage";

import type { BotSdkContext } from "../../plugin";
import { storeMailFiles } from "../conversation";

import { handIn } from "./hand-in";
import { emailText } from "./email-text";
import { bareAddress, type EmailChannel, type InboundMail } from "../../channel/internal";

/**
 * Takes one inbound mail of the email Channel (spec #761), as its provider parsed it. It wakes the
 * Bot whose address it was sent to only when its From is the Bot's user's verified email
 * (case-insensitive) and the provider's DMARC verdict is a pass. It becomes Trigger
 * `email:<Message-ID>`, carrying a new user Message on channel `email`, so a redelivery makes
 * none. Anything else is dropped silently and logged.
 */
export async function receiveEmail(
  sdk: BotSdkContext,
  {
    channel,
    verifiedEmail,
  }: { channel: EmailChannel; verifiedEmail: (userId: string) => Promise<string | null> },
  mail: InboundMail,
): Promise<void> {
  const dropped = await deliver(sdk, channel, verifiedEmail, mail);
  // A provider delivers at least once, so a redelivery is routine and goes unlogged, as is the
  // Bots' own outbound mail, which a local mail catcher posts back here.
  if (dropped && dropped !== redelivery && dropped !== ownMail)
    sdk.logger.error(`Dropped an inbound email (${dropped})`, { to: mail.to });
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
    // By id alone: a Message-ID names one mail, whichever Bot it reached first.
    .where(eq(botTrigger.id, `email:${messageId}`));
  if (alreadySeen) return redelivery;

  // The owner's attachments go to the blob store like a composer's files; the others stay named.
  // Stored even for a paused Bot: only the transaction, under the lock, knows whether it still is
  // (spec #1007), and a paused Bot's are deleted after it.
  const { stored, unkept } = await storeMailFiles(sdk, mail.files ?? []);
  const body = emailText(
    { ...mail, attachments: mail.files ? unkept : mail.attachments },
    channel.domain,
  );
  const handed = await handIn(sdk, {
    botId: owner.botId,
    conversationId: owner.conversationId,
    id: `email:${messageId}`,
    channel: "email",
    body,
    subject: mail.subject,
    files: stored,
    // Rotated since the lookup: the old address has stopped.
    stillValid: async (tx) => {
      const [current] = await tx
        .select({ botId: channelEmailAddress.botId })
        .from(channelEmailAddress)
        .where(eq(channelEmailAddress.address, owner.address));
      return current?.botId === owner.botId;
    },
  });
  if (handed === "refused") return "no Bot has the address";
  return handed === "seen" ? redelivery : null;
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
