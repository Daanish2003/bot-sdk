import type { LinkCode, LinkedIdentityRow } from "@botsdk/client/bot/linked-identity";
import { createHash, randomInt } from "node:crypto";
import { and, asc, eq, gt, lte } from "drizzle-orm";

import type { MessagingAdapter, MessagingUpdate } from "../../channel/internal";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { bot, channelAccount, linkCode, linkedIdentity } from "../../storage";

/*
 * Linked identities and link codes (spec #1044, ADR 0033): a user proves which platform account is
 * theirs by sending a one-time code to any of their Bots on a messaging Channel.
 */

/** How long a link code is valid. */
const codeLifetimeMs = 10 * 60_000;

const hashOf = (code: string) =>
  createHash("sha256").update(`botsdk:link-code:${code}`).digest("hex");

/** The code a message is: the whole text, or Telegram's `/start <code>`; else `null`. */
export function codeIn(text: string): string | null {
  const match = /^(?:\/start(?:@\w+)?\s+)?(\d{6})$/.exec(text.trim());
  return match?.[1] ?? null;
}

/** Whether Postgres refused a write on a unique constraint. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Throws NOT_FOUND when the Host offers no messaging Channel. */
function requireMessaging(adapters: readonly MessagingAdapter[]) {
  if (adapters.length === 0) {
    throw rpcError("NOT_FOUND", "error.channelPlatformNotFound", "No messaging Channel is offered");
  }
}

/** The user's Linked identities, one per platform. */
export async function listLinkedIdentities(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  userId: string,
): Promise<LinkedIdentityRow[]> {
  requireMessaging(adapters);
  const rows = await sdk.db
    .select()
    .from(linkedIdentity)
    .where(eq(linkedIdentity.userId, userId))
    .orderBy(asc(linkedIdentity.platform));
  return rows.map((row) => ({
    platform: row.platform,
    handle: row.handle,
    linkedAt: row.linkedAt,
  }));
}

/** Unlinks the user's Linked identity on `platform` at once. */
export async function unlinkIdentity(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  { userId, platform }: { userId: string; platform: string },
): Promise<void> {
  requireMessaging(adapters);
  await sdk.db
    .delete(linkedIdentity)
    .where(and(eq(linkedIdentity.userId, userId), eq(linkedIdentity.platform, platform)));
}

/**
 * Issues the user a link code, replacing their live one, with the deep links of their Bots'
 * active Channel accounts whose platform has one.
 */
export async function issueLinkCode(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  userId: string,
): Promise<LinkCode> {
  requireMessaging(adapters);
  const now = sdk.clock();
  const expiresAt = new Date(now.getTime() + codeLifetimeMs);
  let code = "";
  // A code another user holds live is refused by the unique hash: draw again.
  for (let attempt = 1; ; attempt++) {
    code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await sdk.db.transaction(async (tx) => {
        await tx.delete(linkCode).where(lte(linkCode.expiresAt, now));
        await tx
          .insert(linkCode)
          .values({ userId, codeHash: hashOf(code), expiresAt })
          .onConflictDoUpdate({
            target: linkCode.userId,
            set: { codeHash: hashOf(code), expiresAt },
          });
      });
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 10) throw error;
    }
  }
  const accounts = await sdk.db
    .select({
      platform: channelAccount.platform,
      botId: bot.id,
      botName: bot.name,
      platformBotId: channelAccount.platformBotId,
      handle: channelAccount.handle,
    })
    .from(channelAccount)
    .innerJoin(bot, eq(bot.id, channelAccount.botId))
    .where(and(eq(bot.userId, userId), eq(channelAccount.status, "active")))
    .orderBy(asc(bot.name), asc(channelAccount.platform));
  const links: LinkCode["links"] = [];
  for (const account of accounts) {
    const adapter = adapters.find((candidate) => candidate.id === account.platform);
    const url = adapter?.deepLink(account, code);
    if (url) {
      links.push({
        platform: account.platform,
        botId: account.botId,
        botName: account.botName,
        handle: account.handle,
        url,
      });
    }
  }
  return { code, expiresAt, links };
}

/**
 * Takes `update` from a sender who isn't the Bot owner's Linked identity: when it is a valid code
 * of the Bot's owner, sent in a private chat, links the sender for the platform, spends the code and
 * returns `true`. Anything else, including a sender already linked to another user (the code
 * stays unspent), returns `false`, to be dropped silently.
 */
export async function linkFromCode(
  sdk: BotSdkContext,
  platform: string,
  botId: string,
  update: MessagingUpdate,
): Promise<boolean> {
  // Called on the logger, so a class-based one keeps its `this`. Never the text or the code.
  const drop = (reason: string) => {
    sdk.logger.debug?.(`A ${platform} update was dropped: ${reason}`);
    return false;
  };
  const code = update.press || !update.chat.private ? null : codeIn(update.text);
  if (!code) return drop("the sender is unknown and it is not a link code");
  const [owner] = await sdk.db.select({ userId: bot.userId }).from(bot).where(eq(bot.id, botId));
  if (!owner) return drop("its Bot is gone");
  // The owner's own Linked identity is not an unknown sender: its message is the Bot's to take.
  const [own] = await sdk.db
    .select({
      platformUserId: linkedIdentity.platformUserId,
      workspaceId: linkedIdentity.workspaceId,
    })
    .from(linkedIdentity)
    .where(and(eq(linkedIdentity.userId, owner.userId), eq(linkedIdentity.platform, platform)));
  if (
    own?.platformUserId === update.sender.id &&
    own.workspaceId === (update.sender.workspace ?? null)
  ) {
    return false;
  }
  const now = sdk.clock();
  const refused = new Error("refused");
  try {
    await sdk.db.transaction(async (tx: Transaction) => {
      const spent = await tx
        .delete(linkCode)
        .where(
          and(
            eq(linkCode.userId, owner.userId),
            eq(linkCode.codeHash, hashOf(code)),
            gt(linkCode.expiresAt, now),
          ),
        )
        .returning({ userId: linkCode.userId });
      if (spent.length === 0) throw refused;
      // Linking again replaces the user's identity on the platform.
      await tx
        .delete(linkedIdentity)
        .where(and(eq(linkedIdentity.userId, owner.userId), eq(linkedIdentity.platform, platform)));
      await tx.insert(linkedIdentity).values({
        id: uuidv7(),
        userId: owner.userId,
        platform,
        platformUserId: update.sender.id,
        handle: update.sender.handle,
        workspaceId: update.sender.workspace ?? null,
        linkedAt: now,
      });
    });
    return true;
  } catch (error) {
    // The sender belongs to another user: the transaction rolled back, so the code is unspent.
    if (error === refused) return drop("the link code is wrong, expired or spent");
    if (isUniqueViolation(error)) return drop("the sender is linked to another user");
    throw error;
  }
}
