import { eq } from "drizzle-orm";

import { bot, message, pushSubscription } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import type { PushNotification, WebPushChannel } from "../../channel/internal";
import { toBotMessage } from "./store";

/** The longest push body: a push's payload is small (about 4 KB), and a notification shows less. */
const maxBodyLength = 200;

/** Whether web push reaches any of the user's devices. */
export async function hasPushSubscription(
  db: BotSdkContext["db"] | Transaction,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ endpoint: pushSubscription.endpoint })
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId))
    .limit(1);
  return row !== undefined;
}

/** The first non-empty line of `text`, cut to `maxBodyLength`. */
function firstLineOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((one) => one.trim())
      .find(Boolean) ?? "";
  return line.length > maxBodyLength ? `${line.slice(0, maxBodyLength - 1)}…` : line;
}

/**
 * Pushes Bot Message `messageId` to each of its user's devices: the Bot's name and the Message's
 * first line, opening the Conversation. A device whose push service answers 404 or 410 is gone, so
 * its subscription is deleted and not retried. Any other failure throws once every device was
 * tried, and the runner retries the job: a device pushed again gets the same `tag`, which replaces
 * the notification it already shows. A Message or Bot deleted since pushes nothing.
 */
export async function sendPushDelivery(
  deps: BotSdkContext,
  push: WebPushChannel,
  { messageId }: { messageId: string },
): Promise<void> {
  const [row] = await deps.db
    .select({
      id: message.id,
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt,
      botId: bot.id,
      userId: bot.userId,
      name: bot.name,
    })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(eq(message.id, messageId));
  if (!row) return;
  const devices = await deps.db
    .select()
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, row.userId));
  const notification: PushNotification = {
    title: row.name,
    body: firstLineOf(toBotMessage(row).text),
    url: `${push.appUrl}/bots/${row.botId}`,
    tag: messageId,
  };
  const results = await Promise.allSettled(
    devices.map(async ({ endpoint, p256dh, auth }) => {
      const sent = await push.provider.send({ endpoint, keys: { p256dh, auth } }, notification, {
        fetch: deps.fetch,
      });
      if (sent === "gone") {
        await deps.db.delete(pushSubscription).where(eq(pushSubscription.endpoint, endpoint));
      }
    }),
  );
  const failed = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failed.length > 0) {
    throw new AggregateError(
      failed,
      `Couldn't push to ${failed.length} of ${devices.length} devices`,
    );
  }
}
