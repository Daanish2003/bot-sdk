import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import {
  decryptCredentials,
  encryptCredentials,
  encryptionKid,
  kidOf,
} from "../../credentials/encryption";
import { rotateInPasses } from "../../credentials/rotation";
import { isUniqueViolation } from "../../lib/unique-violation";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { bot, channelAccount } from "../../storage";
import type { HeldAccountInput, MessagingAccount, MessagingAdapter } from "../../channel/internal";
import { findBot } from "./store";

/*
 * The Channel accounts (spec #1044, ADR 0033), each held by one Bot, one per Bot and messaging
 * platform, or by one holder a feature keeps in its own table (ticket #1331), its credentials encrypted
 * under the keyring with a key of their own kind.
 */

type AccountRow = typeof channelAccount.$inferSelect;

/**
 * The keyring options of an account's credentials, bound to its platform and its Bot, or, held by a
 * feature, its own id: the core can't read who a feature's holder is.
 */
const encryption = (sdk: BotSdkContext, botOrAccountId: string, platform: string) => ({
  secrets: sdk.keyring,
  kind: "channel" as const,
  context: `${botOrAccountId}:${platform}`,
});

/** The messaging adapter of `platform`, or NOT_FOUND. */
function adapterOf(adapters: readonly MessagingAdapter[], platform: string): MessagingAdapter {
  const adapter = adapters.find((candidate) => candidate.id === platform);
  if (!adapter) {
    throw rpcError("NOT_FOUND", "error.channelPlatformNotFound", "No such messaging Channel");
  }
  return adapter;
}

/** The user's Bot `botId` once the Host has a messaging Channel, or NOT_FOUND. */
async function ownBot(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  userId: string,
  botId: string,
) {
  if (adapters.length === 0) {
    throw rpcError("NOT_FOUND", "error.channelPlatformNotFound", "No messaging Channel is offered");
  }
  const found = await findBot(sdk.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  return found;
}

/** A platform's row as the RPCs return it: never the credentials. */
function rowOf(adapter: MessagingAdapter, account: AccountRow | undefined): ChannelAccountRow {
  return {
    platform: adapter.id,
    fields: [...adapter.credentialFields],
    account: account
      ? {
          handle: account.handle,
          status: account.status,
          reason: account.reason,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        }
      : null,
  };
}

/** Each messaging platform the Host offers, in its order, with the Bot's Channel account there. */
export async function listChannelAccounts(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  { userId, botId }: { userId: string; botId: string },
): Promise<ChannelAccountRow[]> {
  await ownBot(sdk, adapters, userId, botId);
  const rows = await sdk.db.select().from(channelAccount).where(eq(channelAccount.botId, botId));
  return adapters.map((adapter) =>
    rowOf(
      adapter,
      rows.find((row) => row.platform === adapter.id),
    ),
  );
}

const takenError = () =>
  rpcError(
    "CONFLICT",
    "error.channelAccountTaken",
    "That platform bot is already connected to someone else",
  );

/** Only the fields `adapter` takes, each given, once the platform accepts them; else BAD_REQUEST. */
async function acceptedCredentials(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  given: Record<string, string>,
) {
  const rejected = () =>
    rpcError(
      "BAD_REQUEST",
      "error.channelCredentialsRejected",
      "The platform rejected these credentials",
    );
  const credentials: Record<string, string> = {};
  for (const field of adapter.credentialFields) {
    const value = given[field]?.trim();
    if (!value) throw rejected();
    credentials[field] = value;
  }
  const checked = await adapter.check(credentials, { fetch: sdk.fetch });
  if ("rejected" in checked) throw rejected();
  return { credentials, checked };
}

/**
 * The account already on this platform bot, locked, and the user whose it is: a Bot's user, or the
 * one the feature holding it names. No enabled feature naming one leaves `userId` null.
 */
async function accountOfPlatformBot(
  sdk: BotSdkContext,
  tx: Transaction,
  platform: string,
  platformBotId: string,
) {
  const [found] = await tx
    .select({ id: channelAccount.id, botId: channelAccount.botId, userId: bot.userId })
    .from(channelAccount)
    .leftJoin(bot, eq(bot.id, channelAccount.botId))
    .where(
      and(eq(channelAccount.platform, platform), eq(channelAccount.platformBotId, platformBotId)),
    )
    .for("update", { of: channelAccount });
  if (!found) return undefined;
  if (found.userId !== null) return found;
  for (const { feature, context } of sdk.parts.features) {
    const userId = await feature.channelAccountOwner?.(tx, found.id, context);
    if (userId) return { ...found, userId };
  }
  return found;
}

/**
 * Runs `write`, once more on a clash: a save of the same platform bot raced it, and the row that
 * save wrote is there to move or refuse.
 */
async function retryingClash<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isUniqueViolation(error, "channel_account_platform_bot_unique")) throw error;
      if (attempt === 2) throw takenError();
    }
  }
}

/**
 * Adds or fixes the Bot's Channel account on `platform` once the platform accepts `credentials`.
 * A platform bot on another of the user's Bots, or a holder of a feature's, moves here. Returns the
 * platform's row and the ids of the accounts whose listeners must change (this one, and the one it moved from).
 */
export async function saveChannelAccount(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  {
    userId,
    botId,
    platform,
    credentials: given,
  }: { userId: string; botId: string; platform: string; credentials: Record<string, string> },
): Promise<{ row: ChannelAccountRow; changed: string[] }> {
  await ownBot(sdk, adapters, userId, botId);
  const adapter = adapterOf(adapters, platform);
  const { credentials, checked } = await acceptedCredentials(sdk, adapter, given);

  const encrypted = encryptCredentials(credentials, encryption(sdk, botId, platform));
  const now = sdk.clock();
  return retryingClash(() =>
    sdk.db.transaction(async (tx) => {
      const changed: string[] = [];
      const elsewhere = await accountOfPlatformBot(sdk, tx, platform, checked.platformBotId);
      if (elsewhere && elsewhere.botId !== botId) {
        if (elsewhere.userId !== userId) throw takenError();
        // A platform bot is on one holder only: it moves to this Bot.
        await tx.delete(channelAccount).where(eq(channelAccount.id, elsewhere.id));
        changed.push(elsewhere.id);
      }
      const [saved] = await tx
        .insert(channelAccount)
        .values({
          id: uuidv7(),
          botId,
          platform,
          platformBotId: checked.platformBotId,
          handle: checked.handle,
          encrypted,
          status: "active",
          reason: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [channelAccount.botId, channelAccount.platform],
          set: {
            platformBotId: checked.platformBotId,
            handle: checked.handle,
            encrypted,
            status: "active",
            reason: null,
            updatedAt: now,
          },
        })
        .returning();
      changed.push(saved!.id);
      return { row: rowOf(adapter, saved), changed };
    }),
  );
}

/**
 * Adds or fixes a Channel account a feature holds, once the platform accepts `credentials`, with no
 * Bot. `hold` records the feature's holder in the same transaction. A platform bot the user has on a
 * Bot moves here; one the user's feature already holds keeps its row, for `hold` to keep or move; one
 * of another user's is refused. Returns the row and the ids of the accounts whose listeners must change.
 */
export async function saveHeldChannelAccount(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  { userId, platform, credentials: given, hold }: HeldAccountInput,
): Promise<{ row: ChannelAccountRow; changed: string[] }> {
  const adapter = adapterOf(adapters, platform);
  const { credentials, checked } = await acceptedCredentials(sdk, adapter, given);
  const now = sdk.clock();
  return retryingClash(() =>
    sdk.db.transaction(async (tx) => {
      const changed: string[] = [];
      const elsewhere = await accountOfPlatformBot(sdk, tx, platform, checked.platformBotId);
      if (elsewhere && elsewhere.userId !== userId) throw takenError();
      if (elsewhere?.botId) {
        await tx.delete(channelAccount).where(eq(channelAccount.id, elsewhere.id));
        changed.push(elsewhere.id);
      }
      const id = elsewhere && !elsewhere.botId ? elsewhere.id : uuidv7();
      const encrypted = encryptCredentials(credentials, encryption(sdk, id, platform));
      const [saved] = await tx
        .insert(channelAccount)
        .values({
          id,
          botId: null,
          platform,
          platformBotId: checked.platformBotId,
          handle: checked.handle,
          encrypted,
          status: "active",
          reason: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: channelAccount.id,
          set: {
            handle: checked.handle,
            encrypted,
            status: "active",
            reason: null,
            updatedAt: now,
          },
        })
        .returning();
      await hold(tx, id);
      changed.push(id);
      return { row: rowOf(adapter, saved), changed };
    }),
  );
}

/** Deletes the accounts `ids` a feature holds, in the caller's transaction. A Bot's stay. */
export async function removeHeldChannelAccounts(
  tx: Transaction,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .delete(channelAccount)
    .where(and(inArray(channelAccount.id, [...ids]), isNull(channelAccount.botId)));
}

/** Removes the Bot's Channel account on `platform`; the ids of the accounts removed. */
export async function removeChannelAccount(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  { userId, botId, platform }: { userId: string; botId: string; platform: string },
): Promise<string[]> {
  await ownBot(sdk, adapters, userId, botId);
  const removed = await sdk.db
    .delete(channelAccount)
    .where(and(eq(channelAccount.botId, botId), eq(channelAccount.platform, platform)))
    .returning({ id: channelAccount.id });
  return removed.map((row) => row.id);
}

/** The ids of the active Channel accounts on `platforms`. */
export async function activeChannelAccountIds(
  sdk: BotSdkContext,
  platforms: readonly string[],
): Promise<string[]> {
  if (platforms.length === 0) return [];
  const rows = await sdk.db
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(and(eq(channelAccount.status, "active"), inArray(channelAccount.platform, platforms)));
  return rows.map((row) => row.id);
}

/** The ids of the Channel accounts of the Bots of `conversationIds`, as their delete sees them. */
export async function channelAccountIdsOf(
  tx: Transaction,
  conversationIds: readonly string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const rows = await tx
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .innerJoin(bot, eq(bot.id, channelAccount.botId))
    .where(inArray(bot.conversationId, [...conversationIds]));
  return rows.map((row) => row.id);
}

/**
 * A Channel account as its listener needs it: the account with its credentials decrypted, its
 * platform and status, and `version`, its ciphertext, which a fresh IV changes with every save of
 * its credentials (and every key rotation). `null`
 * when it is gone; `account` is `null` when no key of the keyring reads its credentials.
 */
export async function listenerAccount(sdk: BotSdkContext, id: string) {
  const [row] = await sdk.db.select().from(channelAccount).where(eq(channelAccount.id, id));
  if (!row) return null;
  const decrypted = decryptCredentials(
    row.encrypted,
    encryption(sdk, row.botId ?? row.id, row.platform),
  );
  const account: MessagingAccount | null = decrypted.ok
    ? {
        id: row.id,
        botId: row.botId,
        platformBotId: row.platformBotId,
        handle: row.handle,
        credentials: decrypted.credentials,
      }
    : null;
  return {
    account,
    platform: row.platform,
    status: row.status,
    version: row.encrypted,
  };
}

/**
 * Marks the Channel account as needing attention with `reason`, unless its credentials were saved
 * again since `version`.
 */
export async function markNeedsAttention(
  sdk: BotSdkContext,
  id: string,
  version: string,
  reason: string,
): Promise<void> {
  await sdk.db
    .update(channelAccount)
    .set({ status: "needs_attention", reason: reason.slice(0, 500) || "Rejected" })
    .where(and(eq(channelAccount.id, id), eq(channelAccount.encrypted, version)));
}

/** One scan over every Channel account; `raced` counts updates that found the row changed. */
async function rotateOnce(sdk: BotSdkContext, batchSize: number) {
  const result = { reencrypted: 0, raced: 0, unreadable: 0 };
  let after: string | undefined;
  for (;;) {
    const rows = await sdk.db
      .select()
      .from(channelAccount)
      .where(after === undefined ? undefined : gt(channelAccount.id, after))
      .orderBy(asc(channelAccount.id))
      .limit(batchSize);
    for (const row of rows) {
      const options = encryption(sdk, row.botId ?? row.id, row.platform);
      const decrypted = decryptCredentials(row.encrypted, options);
      if (!decrypted.ok) {
        result.unreadable += 1;
        continue;
      }
      if (kidOf(row.encrypted) === encryptionKid(options.secrets, options.kind)) continue;
      const updated = await sdk.db
        .update(channelAccount)
        .set({ encrypted: encryptCredentials(decrypted.credentials, options) })
        .where(and(eq(channelAccount.id, row.id), eq(channelAccount.encrypted, row.encrypted)))
        .returning({ id: channelAccount.id });
      if (updated.length === 0) result.raced += 1;
      result.reencrypted += updated.length;
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) return result;
    after = last.id;
  }
}

/**
 * Re-encrypts every Channel account's credentials whose key isn't the keyring's first (ADR 0010),
 * in batches, and counts the rows no key can read, which stay in place.
 */
export async function rotateChannelAccountKeys(
  sdk: BotSdkContext,
  { batchSize = 100 }: { batchSize?: number } = {},
) {
  const { reencrypted, unreadable } = await rotateInPasses(() => rotateOnce(sdk, batchSize));
  if (unreadable > 0) {
    sdk.logger.error("Stored Channel account credentials can't be read; left in place", {
      unreadable,
    });
  }
  return { reencrypted, unreadable };
}
