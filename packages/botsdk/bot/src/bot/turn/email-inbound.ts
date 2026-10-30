import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";

import {
  bot,
  botRoomMember,
  botTrigger,
  channelEmailAddress,
  conversation,
  deleteBlobsBestEffort,
  message,
} from "../../storage";

import type { BotSdkContext } from "../../plugin";
import { sentFileBlobKey, storeMailFiles } from "../conversation";

import { handIn } from "./hand-in";
import { emailText } from "./email-text";
import { postToRoom } from "./turn";
import { bareAddress, type EmailChannel, type InboundMail } from "../../channel/internal";

/**
 * Takes one inbound mail of the email Channel (spec #761), as its provider parsed it. It wakes the
 * Bot whose address it was sent to only when its From is the Bot's user's verified email
 * (case-insensitive) and the provider's DMARC verdict is a pass. It becomes Trigger
 * `email:<Message-ID>`, carrying a new user Message on channel `email`, so a redelivery makes
 * none. A reply in a Room's thread (spec #1055) goes into that Room instead, routed as a Message
 * the user sent there (`roomOfThread`). Anything else is dropped silently and logged.
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
  const room = await roomOfThread(sdk, channel.domain, owner, mail.headers);
  if (room) {
    // A Room that refuses it (one Bot left, a member's Model unavailable, the Quota) leaves the
    // mail to the Bot's 1:1, as an unknown thread does.
    const posted = await postToRoom(sdk, {
      userId: owner.userId,
      conversationId: room,
      triggerId: `email:${messageId}`,
      text: body,
      channel: "email",
      subject: mail.subject,
      files: stored,
    }).catch(async (error: unknown) => {
      if (error instanceof ORPCError) return undefined;
      await dropFiles(sdk, stored);
      throw error;
    });
    if (posted?.outcome === "handed") return null;
    if (posted?.outcome === "seen") {
      await dropFiles(sdk, stored);
      return redelivery;
    }
  }
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

/** Deletes the bytes of mail files no Message holds. */
const dropFiles = (sdk: BotSdkContext, files: { id: string }[]) =>
  deleteBlobsBestEffort(
    sdk,
    files.map((file) => sentFileBlobKey(file.id)),
  );

/** A Message-ID's id: what is between its angle brackets. */
const threadIds = (value: string) =>
  (value.match(/<[^<>]*>/g) ?? []).map((id) => id.slice(1, -1).trim()).filter(Boolean);

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Room whose thread a mail to Bot `owner` replies in (spec #1055), or `undefined` for its 1:1.
 * Its In-Reply-To, then its References newest first, name the mail it answers: a Bot's Message
 * (`<id@domain>`) or the user's earlier mail (an `email:<Message-ID>` Trigger). The first one
 * found decides: a Room of the user that the Bot is still a member of, or else the 1:1.
 */
async function roomOfThread(
  sdk: BotSdkContext,
  domain: string,
  owner: { botId: string; userId: string; conversationId: string },
  headers: Record<string, string>,
): Promise<string | undefined> {
  const header = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
  const ids = [...threadIds(header("in-reply-to")), ...threadIds(header("references")).reverse()];
  const suffix = `@${domain.toLowerCase()}`;
  for (const id of ids) {
    const local = id.toLowerCase().endsWith(suffix) ? id.slice(0, -suffix.length) : undefined;
    const [found] =
      local !== undefined
        ? uuidShape.test(local)
          ? await sdk.db
              .select({ conversationId: message.conversationId })
              .from(message)
              .where(eq(message.id, local.toLowerCase()))
          : []
        : await sdk.db
            .select({ conversationId: botTrigger.conversationId })
            .from(botTrigger)
            .where(eq(botTrigger.id, `email:${id}`))
            .limit(1);
    if (!found) continue;
    if (found.conversationId === owner.conversationId) return undefined;
    const [member] = await sdk.db
      .select({ botId: botRoomMember.botId })
      .from(botRoomMember)
      .innerJoin(conversation, eq(conversation.id, botRoomMember.conversationId))
      .where(
        and(
          eq(botRoomMember.conversationId, found.conversationId),
          eq(botRoomMember.botId, owner.botId),
          eq(conversation.userId, owner.userId),
        ),
      );
    return member ? found.conversationId : undefined;
  }
  return undefined;
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
