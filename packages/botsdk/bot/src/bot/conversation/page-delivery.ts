import type { PageUrgency } from "@botsdk/client/bot/pages";
import { knownZone } from "@botsdk/client/bot/time-zone";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  appLink,
  CredentialsRejectedError,
  type EmailChannel,
  headerText,
  type MessagingAdapter,
  namedAddress,
  type PageDelivery,
  pageDeliveryPayload,
  pageEmailBody,
  type WebPushChannel,
} from "../../channel/internal";
import type { BotSdkContext, Transaction } from "../../plugin";
import { defineCoreJob, PermanentJobError } from "../../runner/internal";
import { bot, channelAccount, linkedIdentity, page } from "../../storage";
import { inQuietHours, notificationSettingsOf } from "../notifications-api";
import { listenerAccount, markNeedsAttention } from "./channel-accounts";
import { pushToDevices } from "./push-delivery";
import { userTimeZone } from "./rooms";

/*
 * How a Page leaves (ticket #1300): one job per way out, as a Bot Message's delivery has, so a retry
 * of one never repeats another. Nothing here touches a Conversation, a Model or the Quota.
 */

/** How long a Page waits for an acknowledgement before it goes to email too. */
export const pageEmailDelayMs = 10 * 60_000;

const pageJobName = "page.deliver";

/** The Channels a Page can leave on. */
type PageChannels = {
  email?: EmailChannel;
  push?: WebPushChannel;
  messaging: readonly MessagingAdapter[];
};

const minuteMs = 60_000;

/**
 * When a routine Page raised at `now` may go out (ticket #1301): at once outside the owner's hours,
 * else when they end, as the clock reads in the zone the owner last wrote from. The hours are the
 * Quiet hours of their notification settings.
 */
async function releasedAt(tx: Transaction, userId: string, now: Date): Promise<Date> {
  const { quietHours } = await notificationSettingsOf(tx, userId);
  if (!quietHours) return now;
  const zone = knownZone(await userTimeZone(tx, userId));
  if (!inQuietHours(quietHours, now, zone)) return now;
  // Quiet hours are whole minutes and never fill the day, so they end within 24 hours.
  const minute = new Date(Math.floor(now.getTime() / minuteMs) * minuteMs);
  while (inQuietHours(quietHours, minute, zone)) minute.setTime(minute.getTime() + minuteMs);
  return minute;
}

/**
 * Queues Page `id`'s sends, in the transaction that raised it. A Channel the Host lacks has none. A
 * routine Page waits for the owner's hours to end, and its email wait starts when it goes out.
 */
export async function pageIn(
  deps: BotSdkContext,
  tx: Transaction,
  { email, push, messaging }: PageChannels,
  { id, userId, urgency }: { id: string; userId: string; urgency: PageUrgency },
): Promise<void> {
  const now = deps.clock();
  const goesOut = urgency === "emergency" ? now : await releasedAt(tx, userId, now);
  const enqueue = (key: string, payload: PageDelivery, runAfter?: Date) =>
    deps.runner.enqueueIn(tx, pageJobName, payload, {
      idempotencyKey: `page:${id}:${key}`,
      ...(runAfter && { runAfter }),
    });
  const held = goesOut > now ? goesOut : undefined;
  if (push) await enqueue("push", { via: "push", pageId: id }, held);
  if (messaging.length > 0) {
    const linked = await tx
      .select({ platform: linkedIdentity.platform })
      .from(linkedIdentity)
      .where(eq(linkedIdentity.userId, userId));
    for (const { platform } of linked) {
      if (messaging.some((adapter) => adapter.id === platform)) {
        await enqueue(platform, { via: "messaging", pageId: id, platform }, held);
      }
    }
  }
  if (email) {
    const later = new Date(goesOut.getTime() + pageEmailDelayMs);
    await enqueue("email", { via: "email", pageId: id }, later);
  }
}

/** The line a Page's message ends with, leading into the Host app. */
const openInApp = "Open it in the app";

/** Sends Page `pageId` on one Channel. A Page deleted or acknowledged since sends nothing. */
export async function sendPage(
  deps: BotSdkContext,
  { email, push, messaging }: PageChannels,
  verifiedEmail: (userId: string) => Promise<string | null>,
  appUrl: string | null,
  payload: PageDelivery,
): Promise<void> {
  const [row] = await deps.db.select().from(page).where(eq(page.id, payload.pageId));
  if (!row || row.acknowledgedAt) return;
  if (payload.via === "push") {
    if (!push) throw new Error("The channel plugin has no web push adapter");
    await pushToDevices(deps, push, row.userId, {
      title: row.title,
      text: row.text,
      url: `${push.appUrl}${row.path}`,
      tag: row.id,
    });
    return;
  }
  if (payload.via === "messaging") {
    const adapter = messaging.find((candidate) => candidate.id === payload.platform);
    if (!adapter) throw new Error(`The channel plugin has no ${payload.platform} adapter`);
    await sendPageMessage(deps, adapter, appUrl, row);
    return;
  }
  if (!email) throw new Error("The channel plugin has no email adapter");
  const to = await verifiedEmail(row.userId);
  if (!to) throw new PermanentJobError("The Page's user has no verified email");
  await email.provider.send({
    // No Bot sent it, so it has no Bot's address. A Bot's always has a dot, so none can be this one.
    from: namedAddress("Pages", `pages@${email.domain}`),
    to,
    subject: headerText(row.title),
    messageId: `<${row.id}@${email.domain}>`,
    ...pageEmailBody(row.text, { label: openInApp, url: `${email.appUrl}${row.path}` }),
  });
}

/**
 * Sends a Page to the user's Linked identity on `adapter`'s platform, through the first of their
 * Bots' active Channel accounts that gets it there. A Page belongs to no Bot, and a platform may let
 * only the Bot the user wrote to start a chat with them, so each is tried until one does. Rejected
 * credentials mark that account, as any send does. When none got it there, throws: for the retry
 * when an account failed for another reason, and for good otherwise, so the failure is logged.
 */
async function sendPageMessage(
  deps: BotSdkContext,
  adapter: MessagingAdapter,
  appUrl: string | null,
  row: typeof page.$inferSelect,
): Promise<void> {
  const accounts = await deps.db
    .select({ id: channelAccount.id, chatId: linkedIdentity.platformUserId })
    .from(linkedIdentity)
    .innerJoin(bot, eq(bot.userId, linkedIdentity.userId))
    .innerJoin(
      channelAccount,
      and(
        eq(channelAccount.botId, bot.id),
        eq(channelAccount.platform, linkedIdentity.platform),
        eq(channelAccount.status, "active"),
      ),
    )
    .where(and(eq(linkedIdentity.userId, row.userId), eq(linkedIdentity.platform, adapter.id)))
    .orderBy(
      // A paused Bot's account only as a last resort: the alert matters more than its silence.
      asc(sql`${bot.pausedAt} is not null`),
      asc(channelAccount.createdAt),
      asc(channelAccount.id),
    );
  const failures: unknown[] = [];
  for (const { id, chatId } of accounts) {
    const found = await listenerAccount(deps, id);
    if (!found?.account) continue;
    try {
      await adapter.send(
        found.account,
        {
          chatId,
          text: `**${row.title}**\n\n${row.text}`,
          ...(appUrl && {
            control: [appLink(openInApp, `${appUrl}${row.path}`)],
          }),
        },
        { fetch: deps.fetch },
      );
      return;
    } catch (error) {
      if (error instanceof CredentialsRejectedError) {
        await markNeedsAttention(deps, id, found.version, error.reason);
      } else failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Couldn't send Page ${row.id} on ${adapter.id}`);
  }
  throw new PermanentJobError(`No Channel account on ${adapter.id} can carry Page ${row.id}`);
}

/** The job that sends a Page on one Channel. The runner retries a failed send, then logs it. */
export const pageDeliveryJob = defineCoreJob({
  name: pageJobName,
  payload: pageDeliveryPayload,
  run: async (payload, { deps }) => deps.channels.sendPage(payload),
  onFailed: (payload, error, { deps }) => {
    deps.logger.error(`Couldn't send Page ${payload.pageId} by ${payload.via}`, error);
  },
});
