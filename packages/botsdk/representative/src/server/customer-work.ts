import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { botAssignment } from "@botsdk/bot/storage";
import {
  representative,
  representativeCustomerMerge,
  representativeHandOff,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";

/*
 * What a Turn reads live of a verified Customer's own work (ticket #1284, ADR 0035): the status of the
 * Assignments handed to a Bot from their threads, and what the Bot said for them. Nothing here is
 * copied into memory. Code gives the Customer's id, from the thread the Turn answers: the tool takes
 * none, and no Model output names one.
 */

/** How many Assignments one read returns, the newest first. */
const workLimit = 20;

/** What a read says of one Assignment. `forCustomer` is set only once a Bot ended it with some. */
export type CustomerWork = {
  assignmentId: string;
  title: string;
  status: string;
  forCustomer?: string;
};

type Db = FeatureContext["db"] | Transaction;

/**
 * `customerId` and every Customer merged into it, directly or through others, by a merge not undone.
 * A hand-off keeps the Customer it was made for, so work follows a merge through this, and an undone
 * merge gives it back.
 */
async function customerAndAbsorbed(db: Db, userId: string, customerId: string) {
  const merge = representativeCustomerMerge;
  const ids = new Set([customerId]);
  for (let frontier = [customerId]; frontier.length > 0;) {
    const absorbed = await db
      .select({ id: merge.absorbedCustomerId })
      .from(merge)
      .where(
        and(
          eq(merge.userId, userId),
          inArray(merge.survivorCustomerId, frontier),
          isNull(merge.undoneAt),
        ),
      );
    frontier = absorbed.map((row) => row.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

/**
 * The newest Assignments of `userId`'s Representatives that belong to `customerId`: handed off from
 * one of the Customer's threads, made for the Customer or a Customer merged into them, or told in one
 * of their threads. A delivered hand-off has lost its thread, so that alone doesn't bound the scope.
 */
export async function readCustomerWork(
  db: Db,
  userId: string,
  customerId: string,
): Promise<CustomerWork[]> {
  const customers = await customerAndAbsorbed(db, userId, customerId);
  const handOff = representativeHandOff;
  const thread = representativeThread;
  const theirThreads = db
    .select({ id: thread.id })
    .from(thread)
    .where(inArray(thread.customerId, customers));
  const told = db
    .select({ id: representativeThreadMessage.assignmentId })
    .from(representativeThreadMessage)
    .where(
      and(
        isNotNull(representativeThreadMessage.assignmentId),
        inArray(representativeThreadMessage.threadId, theirThreads),
      ),
    );
  const rows = await db
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      status: botAssignment.status,
      result: botAssignment.result,
    })
    .from(handOff)
    .innerJoin(botAssignment, eq(botAssignment.id, handOff.assignmentId))
    .innerJoin(representative, eq(representative.id, handOff.representativeId))
    .where(
      and(
        eq(representative.userId, userId),
        or(
          inArray(handOff.customerId, customers),
          inArray(handOff.threadId, theirThreads),
          inArray(handOff.assignmentId, told),
        ),
      ),
    )
    // Open work first, so a long history of finished work never crowds it out of the limit.
    .orderBy(
      sql`${botAssignment.status} in ('done', 'failed', 'cancelled')`,
      desc(botAssignment.createdAt),
      desc(botAssignment.id),
    )
    .limit(workLimit);
  return rows.map((row) => ({
    assignmentId: row.id,
    title: row.title,
    status: row.status,
    // Only what the Bot wrote for a Customer: its outcome is the owner's.
    ...(row.result?.forCustomer && { forCustomer: row.result.forCustomer }),
  }));
}

/** The strings of `work` a reply may quote as a Bot's result: what the tool answered this Turn. */
export const quotable = (work: CustomerWork) => [
  work.title,
  work.status,
  ...(work.forCustomer ? [work.forCustomer] : []),
];
