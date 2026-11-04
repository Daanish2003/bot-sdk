import { and, desc, eq, inArray, isNull, ne, not, or, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { CustomerMergeView } from "../shared/contract";
import { holdIdentities } from "./customer-proof";
import {
  type CustomerMergeHow,
  type MovedHold,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeThread,
  representativeThreadMessage,
  representativeVerification,
} from "./db/schema";
import { queueIdleCheck } from "./idle";
import { customerNotFound, readCustomer } from "./owner-customers";
import { holdThread, releaseThread } from "./takeover";
import { afterThreadClose } from "./customer-summary";

/*
 * Two Customers become one only by proof or by the owner (ticket #1257), and each merge is recorded
 * so that it can be undone. A message holds its Customer's row until it ends, in a mode this takes
 * the strongest of, so no message is on its way to a Customer as it moves. The absorbed Customer's
 * row stays behind with nothing on it, and only undoing brings it back.
 */

type Services = Pick<FeatureContext, "clock" | "jobs">;
type Context = Services & Pick<FeatureContext, "db">;

const merge = representativeCustomerMerge;

const mergeNotFound = () => rpcError("NOT_FOUND", "error.customerMergeNotFound", "Merge not found");

/** That the Customer row a query reads hasn't been merged into another. */
export const notMergedAway = () =>
  sql`not exists (select 1 from ${merge} where ${merge.absorbedCustomerId} = ${representativeCustomer.id} and ${merge.undoneAt} is null)`;

/** Whether a Customer has been merged into another. Read after its lock, to see the latest. */
export async function isMergedAway(tx: Transaction, customerId: string) {
  const [found] = await tx
    .select({ id: merge.id })
    .from(merge)
    .where(and(eq(merge.absorbedCustomerId, customerId), isNull(merge.undoneAt)));
  return found !== undefined;
}

/** Holds these Customers' rows in id order, so that two merges of the same two can't deadlock. */
export async function holdCustomers(tx: Transaction, ids: string[]) {
  const held = [];
  for (const id of [...new Set(ids)].sort()) {
    const [row] = await tx
      .select({
        id: representativeCustomer.id,
        userId: representativeCustomer.userId,
        blockedAt: representativeCustomer.blockedAt,
      })
      .from(representativeCustomer)
      .where(eq(representativeCustomer.id, id))
      .for("update");
    if (row) held.push(row);
  }
  return held;
}

/**
 * Ends a thread's Turn and closes it. What waited in it stays in it, for the owner to read. Queueing
 * its summary is the caller's: a thread closed for holding two people's words has none.
 */
async function closeThread(
  { jobs }: Services,
  tx: Transaction,
  thread: { id: string; turnId: string | null },
) {
  if (thread.turnId) await jobs.cancelIn(tx, thread.turnId);
  await tx
    .update(representativeThread)
    .set({ state: "closed", turnId: null, waitingFrom: null, waitingSince: null })
    .where(eq(representativeThread.id, thread.id));
}

/**
 * Moves `absorbedId`'s identities and threads onto `survivorId`, both of them the same owner's, held
 * by `tx` and not blocked, and records it. Where both have an open thread with a Representative, the
 * absorbed one's closes, so one open thread stays. If the owner held it, they hold the surviving one
 * too: only their Hand back, or undoing this, gives a thread to the Representative.
 */
export async function absorbCustomer(
  services: Services,
  tx: Transaction,
  {
    userId,
    absorbedId,
    survivorId,
    how,
  }: { userId: string; absorbedId: string; survivorId: string; how: CustomerMergeHow },
) {
  const identity = representativeCustomerIdentity;
  const identities = await tx
    .select({ id: identity.id })
    .from(identity)
    .where(eq(identity.customerId, absorbedId));
  const identityIds = identities.map((row) => row.id);
  await holdIdentities(tx, identityIds);
  await tx
    .update(identity)
    .set({ customerId: survivorId })
    .where(eq(identity.customerId, absorbedId));

  const thread = representativeThread;
  const threadColumns = {
    id: thread.id,
    representativeId: thread.representativeId,
    state: thread.state,
    turnId: thread.turnId,
    turnFrom: thread.turnFrom,
    waitingFrom: thread.waitingFrom,
    lastChannel: thread.lastChannel,
    lastExternalId: thread.lastExternalId,
  };
  const threads = await tx
    .select(threadColumns)
    .from(thread)
    .where(eq(thread.customerId, absorbedId))
    .for("update");
  const surviving = await tx
    .select(threadColumns)
    .from(thread)
    .where(and(eq(thread.customerId, survivorId), ne(thread.state, "closed")))
    .for("update");
  const movedHolds: MovedHold[] = [];
  for (const open of threads) {
    if (open.state === "closed") continue;
    const match = surviving.find((each) => each.representativeId === open.representativeId);
    if (!match) continue;
    await closeThread(services, tx, open);
    // One the owner held gets no summary: undoing this reopens it, held, with its words still to come.
    if (open.state !== "owner") await afterThreadClose(services, tx, open.id);
    if (open.state === "owner") {
      const caused = match.state === "representative";
      if (caused) await holdThread(services, tx, match.id, { ...match, blockedAt: null });
      movedHolds.push({
        closedThreadId: open.id,
        survivingThreadId: match.id,
        caused,
        waitingFrom: open.waitingFrom,
      });
    }
  }
  await tx.update(thread).set({ customerId: survivorId }).where(eq(thread.customerId, absorbedId));
  await tx.insert(merge).values({
    id: uuidv7(),
    userId,
    survivorCustomerId: survivorId,
    absorbedCustomerId: absorbedId,
    how,
    identityIds,
    threadIds: threads.map((row) => row.id),
    movedHolds,
    createdAt: services.clock(),
  });
}

/** Merges the owner's Customer `id` into `intoId`. Neither may be blocked: unblock first. */
export async function mergeCustomers(
  context: Context,
  userId: string,
  { id, intoId }: { id: string; intoId: string },
) {
  if (id === intoId) {
    throw rpcError("CONFLICT", "error.customerMergeSame", "A Customer can't merge into itself");
  }
  await context.db.transaction(async (tx) => {
    const held = await holdCustomers(tx, [id, intoId]);
    if (held.length !== 2 || held.some((row) => row.userId !== userId)) throw customerNotFound();
    if ((await isMergedAway(tx, id)) || (await isMergedAway(tx, intoId))) throw customerNotFound();
    if (held.some((row) => row.blockedAt !== null)) {
      throw rpcError(
        "CONFLICT",
        "error.customerMergeBlocked",
        "Unblock this Customer before merging",
      );
    }
    await absorbCustomer(context, tx, { userId, absorbedId: id, survivorId: intoId, how: "owner" });
  });
  return readCustomer(context, userId, intoId);
}

/** The addresses of a Customer's identities. */
const addressesOf = (tx: Transaction, customerId: string) =>
  tx
    .select({
      id: representativeCustomerIdentity.id,
      channel: representativeCustomerIdentity.channel,
      externalId: representativeCustomerIdentity.externalId,
    })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.customerId, customerId));

type Addresses = Awaited<ReturnType<typeof addressesOf>>;

/**
 * Closes each open thread of a Customer that has words to or from an address not in `own`: since the
 * merge, the other person's, even if the owner has corrected it since. Going on would read them into
 * this one's prompt, and could send to the wrong person. The owner's hold outlives a thread closed
 * this way, on a new empty one, unless the merge alone made it (`mergeHeld`): the next message waits
 * for them as it would have. It gets no summary: that would put the other person's words in this
 * one's memory.
 */
async function closeMixedThreads(
  services: Services,
  tx: Transaction,
  customerId: string,
  own: Addresses,
  mergeHeld: string[],
) {
  const thread = representativeThread;
  const message = representativeThreadMessage;
  const open = await tx
    .select({
      id: thread.id,
      turnId: thread.turnId,
      state: thread.state,
      representativeId: thread.representativeId,
      lastChannel: thread.lastChannel,
      lastExternalId: thread.lastExternalId,
    })
    .from(thread)
    .where(and(eq(thread.customerId, customerId), ne(thread.state, "closed")))
    .for("update");
  if (open.length === 0 || own.length === 0) return;
  const mixed = await tx
    .selectDistinct({ threadId: message.threadId })
    .from(message)
    .where(
      and(
        inArray(
          message.threadId,
          open.map((row) => row.id),
        ),
        not(
          or(
            ...own.map(({ channel, externalId }) =>
              and(eq(message.channel, channel), eq(message.externalId, externalId)),
            ),
          )!,
        ),
      ),
    );
  for (const { threadId } of mixed) {
    const closing = open.find((row) => row.id === threadId)!;
    await closeThread(services, tx, closing);
    if (closing.state !== "owner" || mergeHeld.includes(closing.id)) continue;
    const heard =
      own.find(
        ({ channel, externalId }) =>
          channel === closing.lastChannel && externalId === closing.lastExternalId,
      ) ?? own[0]!;
    const now = services.clock();
    const id = uuidv7();
    await tx.insert(thread).values({
      id,
      customerId,
      representativeId: closing.representativeId,
      state: "owner",
      lastChannel: heard.channel,
      lastExternalId: heard.externalId,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await queueIdleCheck(services, tx, id, now);
  }
}

/**
 * Gives each thread a merge closed its owner's hold and what it had waiting back, on the absorbed
 * Customer, whose threads are
 * back by now. It was that Customer's one open thread with its Representative, and nothing has opened
 * another since: a Customer merged away gets no thread.
 */
async function reopenHeldThreads(
  services: Services,
  tx: Transaction,
  absorbedId: string,
  holds: MovedHold[],
) {
  const thread = representativeThread;
  const now = services.clock();
  for (const { closedThreadId, waitingFrom } of holds) {
    const reopened = await tx
      .update(thread)
      .set({
        state: "owner",
        waitingFrom,
        waitingSince: waitingFrom === null ? null : now,
        updatedAt: sql`greatest(${thread.updatedAt}, ${now.toISOString()}::timestamp)`,
      })
      .where(
        and(
          eq(thread.id, closedThreadId),
          eq(thread.customerId, absorbedId),
          eq(thread.state, "closed"),
        ),
      )
      .returning({ id: thread.id });
    if (reopened.length > 0) await queueIdleCheck(services, tx, closedThreadId, now);
  }
}

/**
 * Undoes one of the owner's merges: each identity and thread that moved goes back to its original
 * Customer. A thread the merge closed stays closed, unless the owner held it, which reopens it held:
 * nothing goes back to the Representative without a Hand back. An identity the owner added since
 * stays on the survivor, and so does a thread begun since, which can't be told apart. A code on its
 * way between the two is void, so that it can't merge them again; and a block set since holds for
 * both, since nothing says which of them it was meant for. What a code merge's sender proved by it
 * goes too, since the owner says they aren't that person, and a thread held only because of the
 * merge, with no Hand back since, goes back to its Representative. A survivor since merged away must
 * come back first. Doing it again changes nothing.
 */
export async function undoMerge(context: Context, userId: string, id: string) {
  const inScope = and(eq(merge.id, id), eq(merge.userId, userId));
  await context.db.transaction(async (tx) => {
    const [found] = await tx.select().from(merge).where(inScope);
    if (!found) throw mergeNotFound();
    const { survivorCustomerId: survivorId, absorbedCustomerId: absorbedId } = found;
    const held = await holdCustomers(tx, [survivorId, absorbedId]);
    // Read under the locks: a Hand back can have changed its holds as this waited.
    const [current] = await tx
      .select({ undoneAt: merge.undoneAt, movedHolds: merge.movedHolds })
      .from(merge)
      .where(inScope);
    if (!current || current.undoneAt) return;
    if (await isMergedAway(tx, survivorId)) {
      throw rpcError(
        "CONFLICT",
        "error.customerMergeLater",
        "Undo the later merge of this Customer first",
      );
    }
    const identity = representativeCustomerIdentity;
    await holdIdentities(tx, found.identityIds);
    await tx
      .update(identity)
      .set({ customerId: absorbedId })
      .where(and(inArray(identity.id, found.identityIds), eq(identity.customerId, survivorId)));
    const returned = await addressesOf(tx, absorbedId);
    const kept = await addressesOf(tx, survivorId);
    const { senderIdentityId: sender, targetIdentityId: target } = representativeVerification;
    const returnedIds = returned.map((row) => row.id);
    const keptIds = kept.map((row) => row.id);
    await tx
      .delete(representativeVerification)
      .where(
        or(
          and(inArray(sender, returnedIds), inArray(target, keptIds)),
          and(inArray(sender, keptIds), inArray(target, returnedIds)),
        ),
      );
    await tx
      .update(representativeThread)
      .set({ customerId: absorbedId })
      .where(
        and(
          inArray(representativeThread.id, found.threadIds),
          eq(representativeThread.customerId, survivorId),
        ),
      );
    await reopenHeldThreads(context, tx, absorbedId, current.movedHolds);
    // A hold another standing merge moved onto the thread still rests there, whatever this one did.
    const others = await tx
      .select({ movedHolds: merge.movedHolds })
      .from(merge)
      .where(and(eq(merge.userId, userId), isNull(merge.undoneAt), ne(merge.id, id)));
    const resting = others.flatMap((other) =>
      other.movedHolds.map((hold) => hold.survivingThreadId),
    );
    const mergeHeld = current.movedHolds
      .filter((hold) => hold.caused && !resting.includes(hold.survivingThreadId))
      .map((hold) => hold.survivingThreadId);
    await closeMixedThreads(context, tx, survivorId, kept, mergeHeld);
    await closeMixedThreads(context, tx, absorbedId, returned, mergeHeld);
    if (found.how === "code") {
      await tx
        .update(identity)
        .set({ verifiedContactAt: null, provenUntil: null })
        .where(inArray(identity.id, found.identityIds));
    }
    if (mergeHeld.length > 0) {
      const stillHeld = await tx
        .select({ id: representativeThread.id, waitingFrom: representativeThread.waitingFrom })
        .from(representativeThread)
        .where(
          and(inArray(representativeThread.id, mergeHeld), eq(representativeThread.state, "owner")),
        )
        .for("update");
      for (const thread of stillHeld) await releaseThread(context, tx, thread.id, thread);
    }
    const blockedAt = held.find((row) => row.id === survivorId)?.blockedAt;
    if (blockedAt) {
      await tx
        .update(representativeCustomer)
        .set({ blockedAt })
        .where(eq(representativeCustomer.id, absorbedId));
    }
    await tx.update(merge).set({ undoneAt: context.clock() }).where(eq(merge.id, id));
  });
  const [view] = await readMerges(context, userId, id);
  return view!;
}

/** The owner's merges, newest first, or the one named by `id`. */
async function readMerges(
  { db }: Pick<FeatureContext, "db">,
  userId: string,
  id?: string,
): Promise<CustomerMergeView[]> {
  const rows = await db
    .select()
    .from(merge)
    .where(and(eq(merge.userId, userId), id ? eq(merge.id, id) : undefined))
    .orderBy(desc(merge.createdAt), desc(merge.id));
  if (rows.length === 0) return [];
  const customers = await db
    .select({ id: representativeCustomer.id, name: representativeCustomer.name })
    .from(representativeCustomer)
    .where(
      inArray(
        representativeCustomer.id,
        rows.flatMap((row) => [row.survivorCustomerId, row.absorbedCustomerId]),
      ),
    );
  const identities = await db
    .select({
      id: representativeCustomerIdentity.id,
      channel: representativeCustomerIdentity.channel,
      externalId: representativeCustomerIdentity.externalId,
    })
    .from(representativeCustomerIdentity)
    .where(
      and(
        eq(representativeCustomerIdentity.userId, userId),
        inArray(
          representativeCustomerIdentity.id,
          rows.flatMap((row) => row.identityIds),
        ),
      ),
    );
  const named = (customerId: string) => ({
    id: customerId,
    name: customers.find((customer) => customer.id === customerId)?.name ?? null,
  });
  return rows.map((row) => ({
    id: row.id,
    how: row.how,
    survivor: named(row.survivorCustomerId),
    absorbed: named(row.absorbedCustomerId),
    identities: identities
      .filter((each) => row.identityIds.includes(each.id))
      .map(({ channel, externalId }) => ({ channel, externalId })),
    createdAt: row.createdAt,
    undoneAt: row.undoneAt,
  }));
}

/** The owner's merges, newest first, undone ones too. */
export const listMerges = (context: Pick<FeatureContext, "db">, userId: string) =>
  readMerges(context, userId);

/** The owner's merges, for their export. */
export async function exportMerges(tx: Transaction, userId: string) {
  return tx
    .select({
      id: merge.id,
      survivorCustomerId: merge.survivorCustomerId,
      absorbedCustomerId: merge.absorbedCustomerId,
      how: merge.how,
      identityIds: merge.identityIds,
      threadIds: merge.threadIds,
      movedHolds: merge.movedHolds,
      createdAt: merge.createdAt,
      undoneAt: merge.undoneAt,
    })
    .from(merge)
    .where(eq(merge.userId, userId))
    .orderBy(merge.createdAt, merge.id);
}
