import { and, desc, eq, sql } from "drizzle-orm";

import { bot, botTrigger, message } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { sentFileBlobKey } from "./files";
import { controlOf, newestTimeZone, subjectOf, toBotMessage, urgentOf } from "./store";
import { knownZone } from "@botsdk/client/bot/time-zone";
import type { NotificationRoute } from "@botsdk/client/bot/notifications";
import { inQuietHours, notificationSettingsOf } from "../notifications-api";
import { defineCoreJob, PermanentJobError } from "../../runner/internal";
import { emailAddressOf } from "./email-address";
import { deliveryPayload, type DeliveryPayload, type EmailChannel } from "../../channel/internal";
import {
  emailBody,
  type FileBytes,
  fitsInOneEmail,
  headerText,
  namedAddress,
  replySubject,
} from "../../channel/internal";

/** The runner job that emails one Bot Message (spec #761). */
export const deliveryJobName = "channel.deliver";

/** A Channel a Bot's Message is delivered on besides web. */
export type DeliveryChannel = "email";

/** The delivery job's key: one per Message and Channel, so a Message is enqueued once. */
export const deliveryKey = (messageId: string, channel: DeliveryChannel) =>
  `${deliveryJobName}:${messageId}:${channel}`;

/** A Message-ID header for `id` on `domain`, deterministic, so a resend repeats it. */
const messageIdOf = (id: string, domain: string) => `<${id}@${domain}>`;

/**
 * The Channel the user last wrote from in Bot `owner`'s Conversation: the channel of its newest
 * user Trigger, or `web` when it has none or that Trigger came from web.
 */
export async function lastUsedChannel(
  db: BotSdkContext["db"] | Transaction,
  owner: { conversationId: string } | { botId: string },
): Promise<"web" | DeliveryChannel> {
  const conversationOf =
    "conversationId" in owner
      ? eq(botTrigger.conversationId, owner.conversationId)
      : eq(
          botTrigger.conversationId,
          db.select({ id: bot.conversationId }).from(bot).where(eq(bot.id, owner.botId)),
        );
  const [last] = await db
    .select({ channel: botTrigger.channel })
    .from(botTrigger)
    .where(and(conversationOf, eq(botTrigger.source, "user")))
    .orderBy(desc(botTrigger.receivedAt), desc(botTrigger.id))
    .limit(1);
  return last?.channel === "email" ? "email" : "web";
}

/**
 * Where a Bot Message goes besides web (spec #761, "Where a Bot's reply is delivered"): by email
 * when Turn `turnId` took a user Trigger by email, and only on web when it took another user
 * Trigger. With no user Trigger in the Turn (a Routine, a Check-in, a Helper, a webhook) or with no
 * Turn at all (a Helper's own Message), it follows the user's notification settings (spec #1024).
 * Returns the email Trigger the Message answers, when it answers one.
 */
async function routeOf(
  deps: BotSdkContext,
  tx: Transaction,
  args: { conversationId: string; messageId: string; turnId: string | null },
): Promise<{ channel: DeliveryChannel; answers?: string } | null> {
  if (args.turnId) {
    const taken = await tx
      .select({ id: botTrigger.id, channel: botTrigger.channel, messageId: botTrigger.messageId })
      .from(botTrigger)
      .where(and(eq(botTrigger.turnId, args.turnId), eq(botTrigger.source, "user")))
      .orderBy(desc(botTrigger.receivedAt), desc(botTrigger.id));
    const emailed = taken.find((trigger) => trigger.channel === "email");
    if (emailed) return { channel: "email", answers: emailed.messageId ?? undefined };
    if (taken.length > 0) return null;
  }
  const route = await unpromptedRouteOf(deps, tx, args);
  return route === "in_app" ? null : { channel: route };
}

/**
 * Where a Message from a Turn the user didn't start goes (spec #1024): the user's choice for urgent
 * Messages or for the rest, or the Channel they last wrote from when that choice is empty. During
 * Quiet hours, in the user's time zone, only an urgent Message leaves the app.
 */
async function unpromptedRouteOf(
  deps: BotSdkContext,
  tx: Transaction,
  { conversationId, messageId }: { conversationId: string; messageId: string },
): Promise<NotificationRoute> {
  const [sent] = await tx
    .select({ parts: message.parts, userId: bot.userId })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(eq(message.id, messageId));
  if (!sent) return "in_app";
  const urgent = urgentOf(sent.parts);
  const settings = await notificationSettingsOf(tx, sent.userId);
  const route =
    (urgent ? settings.urgent : settings.other) ??
    ((await lastUsedChannel(tx, { conversationId })) === "email" ? "email" : "in_app");
  if (route === "in_app" || urgent) return route;
  const zone = knownZone(await newestTimeZone(tx, conversationId));
  return inQuietHours(settings.quietHours, deps.clock(), zone) ? "in_app" : route;
}

/**
 * The Message-ID of the latest mail in the Conversation's thread before Message `messageId`: the
 * user's latest email or the Bot's latest emailed Message, whichever is newer.
 */
async function latestMailOf(
  tx: Transaction,
  {
    conversationId,
    messageId,
    domain,
  }: { conversationId: string; messageId: string; domain: string },
): Promise<string | undefined> {
  // Walks up the Message tree from `messageId`'s parent: the thread order, not timestamps (which
  // tie within a millisecond, as do uuidv7 ids' order).
  const { rows } = await tx.execute<{ id: string; role: string }>(sql`
    WITH RECURSIVE chain AS (
      SELECT m.id, m.parent_id, m.role, m.parts, 0 AS depth FROM botsdk.message m
        WHERE m.conversation_id = ${conversationId}
          AND m.id = (SELECT parent_id FROM botsdk.message WHERE id = ${messageId})
      UNION ALL
      SELECT m.id, m.parent_id, m.role, m.parts, c.depth + 1 FROM botsdk.message m
        JOIN chain c ON m.id = c.parent_id
    )
    SELECT id, role FROM chain WHERE parts->>'channel' = 'email' ORDER BY depth LIMIT 1`);
  const mail = rows[0];
  if (!mail) return undefined;
  if (mail.role === "assistant") return messageIdOf(mail.id, domain);
  const [trigger] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(and(eq(botTrigger.messageId, mail.id), sql`${botTrigger.id} like 'email:%'`))
    .limit(1);
  return trigger ? `<${trigger.id.slice(6)}>` : undefined;
}

/**
 * After Bot Message `messageId` is saved, in the same transaction (which holds the Conversation's
 * row lock): when it goes by email too, marks it emailed (`channel: "email"` on its parts) and
 * enqueues its delivery job, so the enqueue is exactly once and the runner retries the send. The
 * headers are fixed now, in thread order: "Re: <subject>" when it answers an email, or the Bot's
 * name when the Bot speaks first, and In-Reply-To the latest mail in the thread.
 */
export async function deliverIn(
  deps: BotSdkContext,
  tx: Transaction,
  email: EmailChannel,
  args: { conversationId: string; messageId: string; turnId: string | null },
): Promise<void> {
  const route = await routeOf(deps, tx, args);
  if (!route) return;
  const [owner] = await tx
    .select({ name: bot.name })
    .from(bot)
    .where(eq(bot.conversationId, args.conversationId));
  if (!owner) return;
  let subject = headerText(owner.name);
  if (route.answers) {
    const [answered] = await tx
      .select({ parts: message.parts })
      .from(message)
      .where(eq(message.id, route.answers));
    subject = replySubject((answered && subjectOf(answered.parts)) ?? "", owner.name);
  }
  const inReplyTo = await latestMailOf(tx, { ...args, domain: email.domain });
  await tx
    .update(message)
    .set({ parts: sql`jsonb_set(${message.parts}, '{channel}', '"email"')` })
    .where(eq(message.id, args.messageId));
  const payload: DeliveryPayload = {
    messageId: args.messageId,
    subject,
    ...(inReplyTo && { inReplyTo }),
  };
  await deps.runner.enqueueIn(tx, deliveryJobName, payload, {
    idempotencyKey: deliveryKey(args.messageId, "email"),
  });
}

/**
 * Sends the email of one delivery job. A Message or Bot deleted since sends nothing; a user with no
 * verified email can't be mailed, which no retry fixes.
 */
export async function sendDelivery(
  deps: BotSdkContext,
  email: EmailChannel,
  verifiedEmail: (userId: string) => Promise<string | null>,
  { messageId, subject, inReplyTo }: DeliveryPayload,
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
  const to = await verifiedEmail(row.userId);
  if (!to) throw new PermanentJobError("The Bot's user has no verified email");
  const address = await emailAddressOf(deps, {
    userId: row.userId,
    botId: row.botId,
    domain: email.domain,
  });
  const body = emailBody(toBotMessage(row), {
    botUrl: `${email.appUrl}/bots/${row.botId}`,
    files: await filesOf(deps, row.parts),
  });
  await email.provider.send({
    from: namedAddress(row.name, address),
    to,
    subject,
    messageId: messageIdOf(messageId, email.domain),
    ...(inReplyTo && { inReplyTo, references: [inReplyTo] }),
    ...body,
  });
}

/** The files a `files` control holds, with their bytes when they fit in one email. */
async function filesOf(
  deps: BotSdkContext,
  parts: Parameters<typeof controlOf>[0],
): Promise<FileBytes[]> {
  const files = controlOf(parts, "files")?.files ?? [];
  if (!fitsInOneEmail(files)) return files.map((file) => ({ file, bytes: null }));
  return Promise.all(
    files.map(async (file) => ({
      file,
      bytes: await deps.blobStore.get(sentFileBlobKey(file.id)),
    })),
  );
}

/**
 * The job that emails one Bot Message. The runner retries a failed send; once it gives up, the
 * failure is logged and nothing else happens (bounces and a failed-delivery marker are out of scope).
 */
export const deliveryJob = defineCoreJob({
  name: deliveryJobName,
  payload: deliveryPayload,
  run: async (payload, { deps }) => deps.channels.sendDelivery(payload),
  onFailed: (payload, error, { deps }) => {
    deps.logger.error(`Couldn't email Bot Message ${payload.messageId}`, error);
  },
});
