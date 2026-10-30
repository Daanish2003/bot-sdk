import { maxFileBytes } from "@botsdk/client/bot/files";
import { and, eq } from "drizzle-orm";

import type { BotSdkContext } from "../../plugin";
import {
  CredentialsRejectedError,
  type MailFile,
  MailFileTooLargeError,
  type MessagingAccount,
  type MessagingAdapter,
  type MessagingFile,
  MessagingFileTooLargeError,
  type MessagingUpdate,
} from "../../channel/internal";
import { bot, linkedIdentity } from "../../storage";
import { linkFromCode, storeMailFiles } from "../conversation";
import { handIn } from "./hand-in";

/** The system notice sent on a Channel once a sender is linked. It is not a Message. */
const linkedNotice = "Linked to your account.";

/** The note a voice note or audio file leaves in the Message text. */
const voiceNote = "(voice note, not transcribed yet)";

/**
 * The core's one entry point for a messaging update (spec #1044): a Channel account's listener, or
 * a later platform's webhook route, hands it each normalised update of that account. It resolves
 * once the update is stored or dropped, and only then does the listener confirm it to the
 * platform. A sender who sends a valid link code is linked (#1046) and told so by a system notice.
 * A message from the Bot's user's Linked identity, in a private chat, wakes the Bot (#1047); any
 * other update is dropped silently.
 */
export async function receiveMessaging(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: MessagingAccount & { platform: string },
  update: MessagingUpdate,
): Promise<void> {
  // Called on the logger, so a class-based one keeps its `this`. Never the text.
  const drop = (reason: string) =>
    sdk.logger.debug?.(`A ${account.platform} update was dropped: ${reason}`);
  const [owner] = await sdk.db
    .select({ userId: bot.userId, conversationId: bot.conversationId, model: bot.model })
    .from(bot)
    .where(eq(bot.id, account.botId));
  if (!owner) return drop("its Bot is gone");
  // The Bot's user's Linked identity on the platform, workspace included, is who wakes the Bot.
  const [identity] = await sdk.db
    .select({
      platformUserId: linkedIdentity.platformUserId,
      workspaceId: linkedIdentity.workspaceId,
    })
    .from(linkedIdentity)
    .where(
      and(eq(linkedIdentity.userId, owner.userId), eq(linkedIdentity.platform, account.platform)),
    );
  if (
    identity?.platformUserId === update.sender.id &&
    identity.workspaceId === (update.sender.workspace ?? null)
  ) {
    const dropped = await wake(sdk, adapter, account, owner, update);
    if (dropped) drop(dropped);
    return;
  }
  // Anyone else is dropped silently unless the message is a link code (linkFromCode logs why).
  if (!(await linkFromCode(sdk, account.platform, account.botId, update))) return;
  try {
    await adapter.send(
      account,
      { chatId: update.chat.id, text: linkedNotice },
      { fetch: sdk.fetch },
    );
  } catch (error) {
    // The sender is linked already; a failed notice is not retried.
    if (error instanceof CredentialsRejectedError) throw error;
    sdk.logger.error("Sending the Linked notice failed", error);
  }
}

/**
 * Hands the Router the Linked identity's update as a Trigger of the Bot's Conversation; why it was
 * dropped, or `null` once it was handed.
 */
async function wake(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: MessagingAccount & { platform: string },
  owner: { userId: string; conversationId: string; model: string },
  update: MessagingUpdate,
): Promise<string | null> {
  // Rooms are out of scope (spec #1044), and a button press is answered by #1049.
  if (!update.chat.private) return "it is not from a private chat";
  if (update.press) return "it is a button press";
  // The Quota and the Ban as for email: read outside the transaction, and the update is dropped.
  const call = await sdk.models.resolveModelCall(owner.userId, owner.model);
  if (!call) return "the Bot's Model isn't available";
  if (!(await call.meter.mayRun()).ok) return "the user's Quota is spent";
  if (await sdk.isUserBlocked(owner.userId)) return "the user is Banned";

  // Namespaced by platform and Channel account, so a resent update makes no second Trigger.
  const id = `${account.platform}:${account.id}:${update.sourceId}`;

  // Downloaded at once, as the update's own call: a platform's file link may not outlive it.
  const { mailFiles, tooBig } = mailFilesOf(sdk, adapter, account, update.files);
  const { stored, unkept } = await storeMailFiles(sdk, mailFiles);
  const left = [...tooBig, ...unkept];
  const body = [
    update.text.trim(),
    update.files.some((file) => file.kind === "voice" || file.kind === "audio") ? voiceNote : "",
    left.length > 0 ? `Files not kept (too large): ${left.map(oneLine).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!body && stored.length === 0) return "it holds nothing";

  const handed = await handIn(sdk, {
    conversationId: owner.conversationId,
    id,
    channel: account.platform,
    body,
    files: stored,
  });
  return handed === "seen" ? "it is a resent update" : null;
}

/**
 * The update's files as `storeMailFiles` takes them, which downloads each through the adapter within
 * the smaller of the platform's and the SDK's limit; and the names of those the platform says are
 * past its limit, which are never downloaded.
 */
function mailFilesOf(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: MessagingAccount,
  files: MessagingFile[],
): { mailFiles: MailFile[]; tooBig: string[] } {
  const mailFiles: MailFile[] = [];
  const tooBig: string[] = [];
  for (const file of files) {
    if (file.size !== null && file.size > adapter.limits.download) {
      tooBig.push(file.name);
      continue;
    }
    mailFiles.push({
      name: file.name,
      contentType: file.contentType,
      size: file.size ?? 0,
      read: async (maxBytes) => {
        try {
          return await adapter.download(account, file, {
            fetch: sdk.fetch,
            maxBytes: Math.min(maxBytes, adapter.limits.download, maxFileBytes),
          });
        } catch (error) {
          if (error instanceof MessagingFileTooLargeError)
            throw new MailFileTooLargeError(maxBytes);
          throw error;
        }
      },
    });
  }
  return { mailFiles, tooBig };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
