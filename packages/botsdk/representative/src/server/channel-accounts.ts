import { asc, eq, inArray } from "drizzle-orm";

import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { channelAccount } from "@botsdk/bot/storage";
import { representative, representativeChannelAccount } from "./db/schema";
import { requireOwned } from "./representatives";

/*
 * The Channel accounts a Representative holds (ticket #1331, ADR 0033). The core stores and encrypts
 * them and runs their listeners; this keeps who holds each. Connecting one moves it here from wherever
 * the owner has it. There's no owner UI until SMS (#1174).
 */

type Context = Pick<FeatureContext<"channelAccounts">, "db" | "channelAccounts">;

/**
 * Connects the platform bot behind `credentials` to the owner's Representative, once the platform
 * accepts them, and starts its listener. One on another of the owner's holders moves here.
 */
export async function connectChannelAccount(
  { db, channelAccounts }: Context,
  input: {
    userId: string;
    representativeId: string;
    platform: string;
    credentials: Record<string, string>;
  },
): Promise<ChannelAccountRow> {
  const { userId, representativeId, platform, credentials } = input;
  await requireOwned(db, userId, representativeId);
  return channelAccounts.save({
    userId,
    platform,
    credentials,
    // Locked, so a delete of the Representative can't pass this and leave the account behind.
    lock: (tx) => requireOwned(tx, userId, representativeId, true),
    hold: async (tx, channelAccountId) => {
      await tx
        .insert(representativeChannelAccount)
        .values({ channelAccountId, representativeId })
        .onConflictDoUpdate({
          target: representativeChannelAccount.channelAccountId,
          set: { representativeId },
        });
    },
  });
}

/** The Channel accounts the owner's Representative holds, oldest first. */
export async function listChannelAccounts(
  { db }: Pick<Context, "db">,
  userId: string,
  representativeId: string,
) {
  await requireOwned(db, userId, representativeId);
  // Columns are picked one by one, so the encrypted credentials can't leak.
  return db
    .select({
      id: channelAccount.id,
      platform: channelAccount.platform,
      handle: channelAccount.handle,
      status: channelAccount.status,
      reason: channelAccount.reason,
      createdAt: channelAccount.createdAt,
    })
    .from(representativeChannelAccount)
    .innerJoin(channelAccount, eq(channelAccount.id, representativeChannelAccount.channelAccountId))
    .where(eq(representativeChannelAccount.representativeId, representativeId))
    .orderBy(asc(channelAccount.id));
}

/** The user whose Representative holds Channel account `id`, or null when none does. */
export async function ownerOfHeldAccount(tx: Transaction, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: representative.userId })
    .from(representativeChannelAccount)
    .innerJoin(representative, eq(representative.id, representativeChannelAccount.representativeId))
    .where(eq(representativeChannelAccount.channelAccountId, id));
  return row?.userId ?? null;
}

/** Deletes the Channel accounts of the user's Representatives, and returns their ids for the listeners. */
export async function removeHeldAccounts(
  { channelAccounts }: Pick<Context, "channelAccounts">,
  tx: Transaction,
  userId: string,
): Promise<string[]> {
  // Their rows first: a connect waits on them, so none adds an account this would miss.
  const representatives = await tx
    .select({ id: representative.id })
    .from(representative)
    .where(eq(representative.userId, userId))
    .for("update");
  const rows = await tx
    .select({ id: representativeChannelAccount.channelAccountId })
    .from(representativeChannelAccount)
    .where(
      inArray(
        representativeChannelAccount.representativeId,
        representatives.map((row) => row.id),
      ),
    );
  const ids = rows.map((row) => row.id);
  await channelAccounts.removeIn(tx, ids);
  return ids;
}

/** The accounts of the user's Representatives for their export: never the credentials. */
export async function exportHeldAccounts(tx: Transaction, userId: string) {
  return tx
    .select({
      representativeId: representativeChannelAccount.representativeId,
      platform: channelAccount.platform,
      handle: channelAccount.handle,
      status: channelAccount.status,
      createdAt: channelAccount.createdAt,
    })
    .from(representativeChannelAccount)
    .innerJoin(channelAccount, eq(channelAccount.id, representativeChannelAccount.channelAccountId))
    .innerJoin(representative, eq(representative.id, representativeChannelAccount.representativeId))
    .where(eq(representative.userId, userId))
    .orderBy(asc(channelAccount.id));
}
