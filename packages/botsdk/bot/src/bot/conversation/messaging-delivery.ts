import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import {
  CredentialsRejectedError,
  type FileBytes,
  messagingBody,
  type MessagingAdapter,
  MessagingSendError,
  type DeliveryPayload,
  type OutboundMessage,
  type SendProgress,
} from "../../channel/internal";
import type { BotSdkContext, Transaction } from "../../plugin";
import { PermanentJobError } from "../../runner/internal";
import { bot, channelAccount, linkedIdentity, message } from "../../storage";
import { listenerAccount, markNeedsAttention } from "./channel-accounts";
import { sentFileBlobKey } from "./files";
import { authoredBy, notificationOf } from "./rooms";
import { controlOf, toBotMessage } from "./store";

/**
 * Where a Message's buttons were sent on a messaging Channel: kept on its parts (`buttonsOn`), so a
 * typed answer can close them as a press does (spec #1044).
 */
export type ShownButtons = { platform: string; chatId: string; messageId: string };

/** The buttons a Message's stored parts say it was shown with, if any. */
export function shownButtonsOf(parts: { [key: string]: unknown }): ShownButtons | undefined {
  const shown = parts.buttonsOn as Partial<ShownButtons> | undefined;
  return typeof shown?.platform === "string" &&
    typeof shown.chatId === "string" &&
    typeof shown.messageId === "string"
    ? (shown as ShownButtons)
    : undefined;
}

/**
 * How far a failed send of a Message on a messaging Channel got: kept on its parts (`sentOn`), so
 * the `channel.deliver` retry resumes after the parts the user already has (ticket #1067).
 */
type SentOn = SendProgress & { platform: string; chatId: string; body: string };

/**
 * A digest of what a send carries. The parts a failed send got out line up with the retry's only
 * when it is the same (a file whose bytes are gone since is a link in the text instead).
 */
function bodyDigest({ text, buttons, files = [] }: Omit<OutboundMessage, "chatId">): string {
  const shape = files.map(({ name, contentType, content }) => [name, contentType, content.length]);
  return createHash("sha256")
    .update(JSON.stringify([text, buttons ?? null, shape]))
    .digest("base64url");
}

/**
 * What a failed send of this same `body` to `chatId` on `platform` got out, by the Message's stored
 * parts.
 */
function sentOnOf(
  parts: { [key: string]: unknown },
  target: Pick<SentOn, "platform" | "chatId" | "body">,
): SendProgress | undefined {
  const sentOn = parts.sentOn as SentOn | undefined;
  if (
    sentOn?.platform !== target.platform ||
    sentOn.chatId !== target.chatId ||
    sentOn.body !== target.body
  ) {
    return undefined;
  }
  const { platform: _platform, chatId: _chatId, body: _body, ...progress } = sentOn;
  return progress;
}

/** Sets one key of Message `messageId`'s parts in place, so a concurrent write of the others stays. */
function setPartsKey(deps: BotSdkContext, messageId: string, key: string, value: unknown) {
  return deps.db
    .update(message)
    .set({
      parts: sql`jsonb_set(${message.parts}, ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb)`,
    })
    .where(eq(message.id, messageId));
}

/** The messaging platforms each Channels object (`sdk.channels`) has an adapter for. */
const platformsByChannels = new WeakMap<object, readonly string[]>();

/** Records that `channels` (an `sdk.channels`) has adapters for `platforms`. */
export function setMessagingPlatforms(channels: object, platforms: readonly string[]): void {
  platformsByChannels.set(channels, platforms);
}

/**
 * Whether messaging `platform` can carry a Message of Bot `owner` now (spec #1044): the Host's
 * `channels` slot has its adapter, and `messagingTarget` finds a chat. Web and email are never one.
 */
export async function honourable(
  deps: BotSdkContext,
  db: BotSdkContext["db"] | Transaction,
  owner: { conversationId: string } | { botId: string },
  platform: string,
): Promise<boolean> {
  if (!(platformsByChannels.get(deps.channels) ?? []).includes(platform)) return false;
  return (await messagingTarget(db, owner, platform)) !== null;
}

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
 * Sends one `channel.deliver` job's Message on its messaging Channel through the adapter's send
 * (markup and splitting are the adapter's job): its text, its Rich control as buttons, files or a
 * link into the app at `appUrl` (`messagingBody`). A Message or Bot deleted since, an unlinked
 * user or a removed or inactive Channel account sends nothing. The platform rejecting the credentials
 * marks the Channel account as needing attention and ends the job, which no retry fixes. A send that
 * fails after some parts keeps what it sent (`sentOn`), and the retry sends only the rest.
 */
export async function sendMessagingDelivery(
  deps: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  appUrl: string | null,
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
      conversationId: message.conversationId,
      name: bot.name,
    })
    .from(message)
    .innerJoin(bot, authoredBy())
    .where(eq(message.id, messageId));
  if (!row) return;
  const target = await messagingTarget(deps.db, { botId: row.botId }, platform);
  if (!target) return;
  const botMessage = toBotMessage(row);
  const body = messagingBody(botMessage, {
    appUrl: appUrl && `${appUrl}${(await notificationOf(deps.db, row)).path}`,
    files: await filesOf(deps, row.parts, adapter.limits.upload),
    uploadLimit: adapter.limits.upload,
  });
  if (!body.text.trim() && !body.files?.length) return;
  const found = await listenerAccount(deps, target.accountId);
  if (!found?.account)
    throw new PermanentJobError("The Channel account's credentials can't be read");
  const sending = { platform, chatId: target.chatId, body: bodyDigest(body) };
  const resume = sentOnOf(row.parts, sending);
  let sent;
  try {
    sent = await adapter.send(
      found.account,
      { chatId: target.chatId, ...body, ...(resume && { resume }) },
      { fetch: deps.fetch },
    );
  } catch (error) {
    if (error instanceof MessagingSendError) {
      const sentOn: SentOn = { ...sending, ...error.progress };
      // Without it, the retry sends the parts already sent again.
      await setPartsKey(deps, messageId, "sentOn", sentOn).catch((saving: unknown) =>
        deps.logger.error(`Keeping what Bot Message ${messageId} sent failed`, saving),
      );
    }
    if (!(error instanceof CredentialsRejectedError)) throw error;
    await markNeedsAttention(deps, target.accountId, found.version, error.reason);
    throw new PermanentJobError(error.message);
  }
  if (!sent.buttonsMessageId) return;
  const shown: ShownButtons = { platform, chatId: target.chatId, messageId: sent.buttonsMessageId };
  try {
    // One key set in place, so a concurrent answer's write of the parts isn't undone.
    await setPartsKey(deps, messageId, "buttonsOn", shown);
  } catch (error) {
    // Sent already, so not retried: only a typed answer leaves these buttons open.
    deps.logger.error(`Keeping where Bot Message ${messageId}'s buttons were sent failed`, error);
  }
}

/** The files a `files` control holds, with their bytes when the blob store still holds them. */
async function filesOf(
  deps: BotSdkContext,
  parts: Parameters<typeof controlOf>[0],
  uploadLimit: number,
): Promise<FileBytes[]> {
  const files = controlOf(parts, "files")?.files ?? [];
  return Promise.all(
    files.map(async (file) => ({
      file,
      // A file past the limit is only linked, so its bytes are never read.
      bytes: file.size > uploadLimit ? null : await deps.blobStore.get(sentFileBlobKey(file.id)),
    })),
  );
}
