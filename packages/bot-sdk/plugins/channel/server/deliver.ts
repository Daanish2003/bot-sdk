import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { bot, botTrigger, message } from "../../../core/server/db/schema";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { sentFileBlobKey } from "../../bot/server/files";
import { controlOf, toBotMessage } from "../../bot/server/store";
import { defineJob, PermanentJobError } from "../../runner/server/jobs/define";
import { emailAddressOf } from "./address";
import type { EmailChannel } from "./email";
import {
  emailBody,
  type FileBytes,
  maxAttachedBytes,
  namedAddress,
  replySubject,
} from "./email-out";

/** The runner job that emails one Bot Message (spec #761). */
export const deliveryJobName = "channel.deliver";

/** A Channel a Bot's Message is delivered on besides web. */
export type DeliveryChannel = "email";

/** The delivery job's key: one per Message and Channel, so a Message is enqueued once. */
export const deliveryKey = (messageId: string, channel: DeliveryChannel) =>
  `${deliveryJobName}:${messageId}:${channel}`;

/** What a delivery job carries: the headers fixed when the Message was saved. */
const deliveryPayload = z.object({
  messageId: z.uuid(),
  subject: z.string(),
  inReplyTo: z.string().optional(),
});

export type DeliveryPayload = z.infer<typeof deliveryPayload>;

/** A Message-ID header for `id` on `domain`, deterministic, so a resend repeats it. */
const messageIdOf = (id: string, domain: string) => `<${id}@${domain}>`;

/**
 * The Channel the user last wrote from in the Conversation: the channel of its newest user Trigger,
 * or `web` when it has none or that Trigger came from web.
 */
export async function lastUsedChannel(
  db: BotSdkContext["db"] | Transaction,
  conversationId: string,
): Promise<"web" | DeliveryChannel> {
  const [last] = await db
    .select({ channel: botTrigger.channel })
    .from(botTrigger)
    .where(and(eq(botTrigger.conversationId, conversationId), eq(botTrigger.source, "user")))
    .orderBy(desc(botTrigger.receivedAt), desc(botTrigger.id))
    .limit(1);
  return last?.channel === "email" ? "email" : "web";
}

/**
 * Where a Bot Message goes besides web (spec #761, "Where a Bot's reply is delivered"): by email
 * when Turn `turnId` took a user Trigger by email; with no user Trigger in the Turn (a Routine, a
 * Check-in, a Helper, a webhook) or with no Turn at all (a Helper's own Message), on the Channel the
 * user last wrote from. Returns the email Trigger the Message answers, when it answers one.
 */
async function routeOf(
  tx: Transaction,
  { conversationId, turnId }: { conversationId: string; turnId: string | null },
): Promise<{ channel: DeliveryChannel; answers?: string } | null> {
  if (turnId) {
    const taken = await tx
      .select({ id: botTrigger.id, channel: botTrigger.channel, messageId: botTrigger.messageId })
      .from(botTrigger)
      .where(and(eq(botTrigger.turnId, turnId), eq(botTrigger.source, "user")))
      .orderBy(desc(botTrigger.receivedAt), desc(botTrigger.id));
    const emailed = taken.find((trigger) => trigger.channel === "email");
    if (emailed) return { channel: "email", answers: emailed.messageId ?? undefined };
    if (taken.length > 0) return null;
  }
  return (await lastUsedChannel(tx, conversationId)) === "email" ? { channel: "email" } : null;
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
  const [mail] = await tx
    .select({ id: message.id, role: message.role, triggerId: botTrigger.id })
    .from(message)
    .leftJoin(botTrigger, eq(botTrigger.messageId, message.id))
    .where(
      and(
        eq(message.conversationId, conversationId),
        ne(message.id, messageId),
        sql`${message.parts}->>'channel' = 'email'`,
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  if (!mail) return undefined;
  if (mail.role === "assistant") return messageIdOf(mail.id, domain);
  return mail.triggerId?.startsWith("email:") ? `<${mail.triggerId.slice(6)}>` : undefined;
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
  const route = await routeOf(tx, args);
  if (!route) return;
  const [owner] = await tx
    .select({ name: bot.name })
    .from(bot)
    .where(eq(bot.conversationId, args.conversationId));
  if (!owner) return;
  let subject = owner.name;
  if (route.answers) {
    const [answered] = await tx
      .select({ parts: message.parts })
      .from(message)
      .where(eq(message.id, route.answers));
    subject = replySubject(answered?.parts.subject ?? "", owner.name);
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
  await deps.plugin("runner").enqueueIn(tx, deliveryJobName, payload, {
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
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > maxAttachedBytes) return files.map((file) => ({ file, bytes: null }));
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
export const deliveryJob = defineJob({
  name: deliveryJobName,
  payload: deliveryPayload,
  run: async (payload, { deps }) => deps.plugin("channel").sendDelivery(payload),
  onFailed: (payload, error, deps) => {
    deps.logger.error(`Couldn't email Bot Message ${payload.messageId}`, error);
  },
});
