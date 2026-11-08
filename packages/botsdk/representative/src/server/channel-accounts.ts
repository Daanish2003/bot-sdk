import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { channelAccount } from "@botsdk/bot/storage";
import { MessagingSendError } from "@botsdk/bot/channel";
import { AccountSendError, type ChannelOf, smsChannel } from "./customer-proof";
import type { ChannelAccountsView } from "../shared/contract";
import { representative, representativeChannelAccount, representativeThread } from "./db/schema";
import { customerEmailChannel, sendEmail, sendProofEmail } from "./email-address";
import { requireOwned } from "./representatives";

/*
 * The Channel accounts a Representative holds (ticket #1331, ADR 0033). The core stores and encrypts
 * them and runs their listeners; this keeps who holds each. Connecting one moves it here from wherever
 * the owner has it. The owner connects, sees and removes them on the Representative's page (#1358).
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

/** What the owner sees of the Representative's Channel accounts: where one can be connected, and what it holds. */
export async function channelAccountsView(
  context: Pick<Context, "db" | "channelAccounts">,
  userId: string,
  representativeId: string,
): Promise<ChannelAccountsView> {
  return {
    platforms: context.channelAccounts.platforms(),
    accounts: await listChannelAccounts(context, userId, representativeId),
  };
}

/** Connects an account (see `connectChannelAccount`) and returns the owner's view of the Representative's accounts. */
export async function connectChannelAccountView(
  context: Context,
  input: Parameters<typeof connectChannelAccount>[1],
): Promise<ChannelAccountsView> {
  await connectChannelAccount(context, input);
  return channelAccountsView(context, input.userId, input.representativeId);
}

/**
 * Removes one of the Representative's Channel accounts and stops its listener. An account it doesn't
 * hold, another owner's included, is left alone: removing is done once the account isn't there.
 */
export async function removeChannelAccount(
  context: Context,
  userId: string,
  representativeId: string,
  channelAccountId: string,
): Promise<ChannelAccountsView> {
  const removed = await context.db.transaction(async (tx) => {
    await requireOwned(tx, userId, representativeId, true);
    const held = await tx
      .select({ id: representativeChannelAccount.channelAccountId })
      .from(representativeChannelAccount)
      .where(
        and(
          eq(representativeChannelAccount.representativeId, representativeId),
          eq(representativeChannelAccount.channelAccountId, channelAccountId),
        ),
      );
    await context.channelAccounts.removeIn(
      tx,
      held.map((row) => row.id),
    );
    return held.map((row) => row.id);
  });
  await context.channelAccounts.changed(removed);
  return channelAccountsView(context, userId, representativeId);
}

/** The Representative's active account on `channel`: `preferred` while it's there, or the oldest. */
async function accountFor(
  db: Context["db"],
  representativeId: string,
  channel: string,
  preferred: string | null,
) {
  const accounts = await db
    .select({ id: channelAccount.id })
    .from(representativeChannelAccount)
    .innerJoin(channelAccount, eq(channelAccount.id, representativeChannelAccount.channelAccountId))
    .where(
      and(
        eq(representativeChannelAccount.representativeId, representativeId),
        eq(channelAccount.platform, channel),
        eq(channelAccount.status, "active"),
      ),
    )
    .orderBy(asc(channelAccount.id));
  return accounts.find(({ id }) => id === preferred) ?? accounts[0];
}

/**
 * How messages reach a Customer through the accounts Representatives hold: the gate's delivery goes
 * through the Representative's account on the Channel, and the gate reads that adapter's limits.
 * A signed link goes by email (#1348); a code goes nowhere until SMS (#1174) words it.
 */
export const heldAccountChannel = (
  { db, clock, keyring, logger, channelAccounts }: Parameters<ChannelOf>[0],
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
        { db, clock, keyring, logger, channelAccounts, linkUrl },
        { representativeId, externalId, text },
      );
    }
    const account = await accountFor(db, representativeId, channel, channelAccountId);
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
  sendProof: async (to, proof, { representativeId, chatWindow = false }) => {
    if (to.channel === smsChannel) {
      // The code is the text itself, from the account that heard the Customer, to the number it
      // heard. It isn't a thread message, so no prompt or export holds it.
      if (proof.kind !== "code") return;
      const [thread] = await db
        .select({ channelAccountId: representativeThread.channelAccountId })
        .from(representativeThread)
        .where(
          and(
            eq(representativeThread.representativeId, representativeId),
            eq(representativeThread.lastChannel, to.channel),
            eq(representativeThread.lastExternalId, to.externalId),
            ne(representativeThread.state, "closed"),
          ),
        )
        .orderBy(desc(representativeThread.updatedAt))
        .limit(1);
      // Only a number that has written to this line gets a text from it: a claim of a number that
      // hasn't goes nowhere, as it did before SMS. A code a web chat visitor asked for in the chat
      // window (#1361) is for a number on record that may never have written, so it goes through the
      // Representative's oldest active account; the request checked the number first.
      if (!thread && !chatWindow) return;
      const account = await accountFor(
        db,
        representativeId,
        to.channel,
        thread?.channelAccountId ?? null,
      );
      if (!account) throw new Error(`The Representative has no active ${to.channel} account`);
      await channelAccounts.send(account.id, {
        chatId: to.externalId,
        text: chatWindow
          ? `Your verification code is ${proof.secret}. Enter it in the chat window to confirm it's you.`
          : `Your verification code is ${proof.secret}. Reply with it to confirm it's you.`,
      });
      return;
    }
    // A code is read back on a platform that can reach its sender (SMS, #1174); a link goes by email,
    // and so does a code a web chat visitor asked for in the chat window, by a verified address on
    // record (#1350). No other code goes by email: none of those checks stood in front of it.
    if (to.channel !== customerEmailChannel) return;
    if (proof.kind === "code") {
      if (!chatWindow) {
        // Its code is made and goes nowhere, and the Model is told the same either way.
        logger.error(
          `Representative ${representativeId}: a code for an email address, asked for outside the chat window, was not sent`,
        );
        return;
      }
      await sendProofEmail(
        { db, clock, keyring, logger, channelAccounts, linkUrl },
        { representativeId, externalId: to.externalId, code: proof.secret },
      );
      return;
    }
    // Thrown, and logged by the Turn: the Host forgot the option.
    if (!linkUrl) throw new Error("The representative feature has no linkUrl for a signed link");
    const base = linkUrl.replace(/\/+$/, "");
    await sendProofEmail(
      { db, clock, keyring, logger, channelAccounts, linkUrl },
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
