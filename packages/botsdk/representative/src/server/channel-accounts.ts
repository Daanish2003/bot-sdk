import { and, asc, eq, inArray } from "drizzle-orm";

import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { channelAccount } from "@botsdk/bot/storage";
import { MessagingSendError } from "@botsdk/bot/channel";
import { AccountSendError, type ChannelOf } from "./customer-proof";
import { representative, representativeChannelAccount } from "./db/schema";
import { customerEmailChannel, sendEmail, sendProofEmail } from "./email-address";
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

/**
 * How messages reach a Customer through the accounts Representatives hold: the gate's delivery goes
 * through the Representative's account on the Channel, and the gate reads that adapter's limits.
 * A signed link goes by email (#1348); a code goes nowhere until SMS (#1174) words it.
 */
export const heldAccountChannel = (
  { db, keyring, channelAccounts }: Parameters<ChannelOf>[0],
  { linkUrl }: { linkUrl?: string } = {},
): ReturnType<ChannelOf> => ({
  reach: (channel) => channelAccounts.reach(channel),
  send: async (
    { channel, externalId },
    { text },
    { representativeId, channelAccountId, resume },
  ) => {
    if (channel === customerEmailChannel) {
      return sendEmail(
        { db, keyring, channelAccounts, linkUrl },
        { representativeId, externalId, text },
      );
    }
    const accounts = await db
      .select({ id: channelAccount.id })
      .from(representativeChannelAccount)
      .innerJoin(
        channelAccount,
        eq(channelAccount.id, representativeChannelAccount.channelAccountId),
      )
      .where(
        and(
          eq(representativeChannelAccount.representativeId, representativeId),
          eq(channelAccount.platform, channel),
          eq(channelAccount.status, "active"),
        ),
      )
      .orderBy(asc(channelAccount.id));
    // The one they wrote to, or the oldest once that one has gone.
    const account = accounts.find(({ id }) => id === channelAccountId) ?? accounts[0];
    // Thrown, so the runner retries in case it comes back, and the decision log says if it never does.
    if (!account) throw new Error(`The Representative has no active ${channel} account`);
    try {
      // A private chat's id is its user's, as for a Bot's Linked identity.
      await channelAccounts.send(account.id, {
        chatId: externalId,
        text,
        // Another account's chat has none of the parts, so it gets them all.
        ...(resume && (channelAccountId === null || account.id === channelAccountId) && { resume }),
      });
    } catch (error) {
      // Its parts went out on this account, which isn't the one asked for when that one has gone.
      throw error instanceof MessagingSendError ? new AccountSendError(account.id, error) : error;
    }
  },
  sendProof: async (to, proof, { representativeId }) => {
    // A code is read back on a platform that can reach its sender (SMS, #1174); a link goes by email,
    // and so does a code a web chat visitor asked for by an address on record (#1350).
    if (to.channel !== customerEmailChannel) return;
    if (proof.kind === "code") {
      await sendProofEmail(
        { db, keyring, channelAccounts, linkUrl },
        { representativeId, externalId: to.externalId, code: proof.secret },
      );
      return;
    }
    // Thrown, and logged by the Turn: the Host forgot the option.
    if (!linkUrl) throw new Error("The representative feature has no linkUrl for a signed link");
    const base = linkUrl.replace(/\/+$/, "");
    await sendProofEmail(
      { db, keyring, channelAccounts, linkUrl },
      {
        representativeId,
        externalId: to.externalId,
        url: `${base}/representative/verify/${proof.secret}`,
      },
    );
  },
});

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
