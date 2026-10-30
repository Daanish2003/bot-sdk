import { and, eq } from "drizzle-orm";

import {
  CredentialsRejectedError,
  type FileBytes,
  messagingBody,
  type MessagingAdapter,
  type DeliveryPayload,
} from "../../channel/internal";
import type { BotSdkContext, Transaction } from "../../plugin";
import { PermanentJobError } from "../../runner/internal";
import { bot, channelAccount, linkedIdentity, message } from "../../storage";
import { listenerAccount, markNeedsAttention } from "./channel-accounts";
import { sentFileBlobKey } from "./files";
import { controlOf, toBotMessage } from "./store";

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
 * marks the Channel account as needing attention and ends the job, which no retry fixes.
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
    })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(eq(message.id, messageId));
  if (!row) return;
  const target = await messagingTarget(deps.db, { botId: row.botId }, platform);
  if (!target) return;
  const botMessage = toBotMessage(row);
  const body = messagingBody(botMessage, {
    appUrl: appUrl && `${appUrl}/bots/${row.botId}`,
    files: await filesOf(deps, row.parts, adapter.limits.upload),
    uploadLimit: adapter.limits.upload,
  });
  if (!body.text.trim() && !body.files?.length) return;
  const found = await listenerAccount(deps, target.accountId);
  if (!found?.account)
    throw new PermanentJobError("The Channel account's credentials can't be read");
  try {
    await adapter.send(found.account, { chatId: target.chatId, ...body }, { fetch: deps.fetch });
  } catch (error) {
    if (!(error instanceof CredentialsRejectedError)) throw error;
    await markNeedsAttention(deps, target.accountId, found.version, error.reason);
    throw new PermanentJobError(error.message);
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
