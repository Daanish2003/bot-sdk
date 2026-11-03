import { and, asc, desc, eq } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { FactLogView, FactSnapshot, FactView } from "../shared/contract";
import { checkFactValue, isInEffect } from "../shared/facts";
import {
  type FactAction,
  type LoggedFact,
  representativeFact,
  representativeFactLog,
  representativeFactProposal,
} from "./db/schema";

/*
 * The owner's Published facts (ticket #1258). Every read and write starts from the owner's id, and
 * a fact of someone else's is "not found", the same as one that doesn't exist. A change applies at
 * once, with no Release, and is logged in the same transaction. The clock is the SDK's, so which
 * facts are in effect, and when a change happened, can be moved by a test.
 */

type Context = Pick<FeatureContext, "db" | "clock">;

/** How many of the newest log entries the owner is shown. */
const maxLogEntries = 500;

const fact = representativeFact;
const log = representativeFactLog;
const proposal = representativeFactProposal;

const factNotFound = () => rpcError("NOT_FOUND", "error.factNotFound", "Fact not found");
const factKeyTaken = () =>
  rpcError("CONFLICT", "error.factKeyTaken", "You already have a fact with that key");

const view = (row: typeof fact.$inferSelect, now: Date): FactView => ({
  id: row.id,
  key: row.key,
  type: row.type,
  topic: row.topic,
  value: row.value,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
  inEffect: isInEffect(row, now),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const logged = (row: FactSnapshot): LoggedFact => ({
  type: row.type,
  topic: row.topic,
  value: row.value,
  validFrom: row.validFrom?.toISOString() ?? null,
  validUntil: row.validUntil?.toISOString() ?? null,
});

/** A logged fact, with its dates read back. */
export const factOf = (stored: LoggedFact): FactSnapshot => ({
  ...stored,
  validFrom: stored.validFrom ? new Date(stored.validFrom) : null,
  validUntil: stored.validUntil ? new Date(stored.validUntil) : null,
});

const snapshot = (stored: LoggedFact | null) => stored && factOf(stored);

async function record(
  tx: Transaction,
  userId: string,
  key: string,
  action: FactAction,
  old: FactSnapshot | null,
  next: FactSnapshot | null,
  at: Date,
  proposedBy: string | null = null,
) {
  const [entry] = await tx
    .insert(log)
    .values({
      id: uuidv7(),
      userId,
      key,
      action,
      old: old && logged(old),
      new: next && logged(next),
      proposedBy,
      at,
    })
    .returning();
  return logView(entry!);
}

/** The value of a fact in the form it is stored in: the input's schema has already checked it fits. */
function stored(type: FactSnapshot["type"], value: string) {
  const checked = checkFactValue(type, value);
  if (checked === null) throw new Error("A fact's value was not checked against its type");
  return checked;
}

type Fields = {
  type: FactSnapshot["type"];
  topic: string;
  value: string;
  validFrom?: Date | null;
  validUntil?: Date | null;
};

export const fieldsOf = (input: Fields): FactSnapshot => ({
  type: input.type,
  topic: input.topic,
  value: stored(input.type, input.value),
  validFrom: input.validFrom ?? null,
  validUntil: input.validUntil ?? null,
});

/** The owner's facts by topic, then key. */
export async function listFacts({ db, clock }: Context, userId: string): Promise<FactView[]> {
  const rows = await db
    .select()
    .from(fact)
    .where(eq(fact.userId, userId))
    .orderBy(asc(fact.topic), asc(fact.key));
  const now = clock();
  return rows.map((row) => view(row, now));
}

/** Adds a fact in `tx`, in effect at once, and logs it; refused when the owner has the key already. */
export async function insertFact(
  tx: Transaction,
  userId: string,
  input: Fields & { key: string },
  now: Date,
): Promise<FactView> {
  const fields = fieldsOf(input);
  const [row] = await tx
    .insert(fact)
    .values({ id: uuidv7(), userId, key: input.key, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [fact.userId, fact.key] })
    .returning();
  if (!row) throw factKeyTaken();
  await record(tx, userId, row.key, "add", null, fields, now);
  return view(row, now);
}

/** Adds a fact, which is in effect at once; refused when the owner has the key already. */
export async function addFact(
  { db, clock }: Context,
  userId: string,
  input: Fields & { key: string },
): Promise<FactView> {
  const now = clock();
  return db.transaction((tx) => insertFact(tx, userId, input, now));
}

/** Changes a fact. A change that leaves it as it was is not logged. */
export async function editFact(
  { db, clock }: Context,
  userId: string,
  { id, ...input }: Fields & { id: string },
): Promise<FactView> {
  const now = clock();
  const fields = fieldsOf(input);
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(fact)
      .where(and(eq(fact.id, id), eq(fact.userId, userId)))
      .for("update");
    if (!before) throw factNotFound();
    const unchanged = JSON.stringify(logged(before)) === JSON.stringify(logged(fields));
    if (unchanged) return view(before, now);
    const [row] = await tx
      .update(fact)
      .set({ ...fields, updatedAt: now })
      .where(eq(fact.id, id))
      .returning();
    await record(tx, userId, before.key, "edit", before, fields, now);
    return view(row!, now);
  });
}

/**
 * Sets the fact of `key` to `fields` in the owner's transaction, for a Bot's proposal they approved,
 * logged as that Bot's. The fact may have been added, changed or deleted since the Bot proposed, so
 * this adds or edits by what is there now. A change that leaves it as it was is not logged.
 */
export async function applyProposedFact(
  tx: Transaction,
  userId: string,
  key: string,
  fields: FactSnapshot,
  proposedBy: string,
  now: Date,
): Promise<FactView> {
  const [before] = await tx
    .select()
    .from(fact)
    .where(and(eq(fact.userId, userId), eq(fact.key, key)))
    .for("update");
  if (before) {
    if (JSON.stringify(logged(before)) === JSON.stringify(logged(fields))) return view(before, now);
    const [row] = await tx
      .update(fact)
      .set({ ...fields, updatedAt: now })
      .where(eq(fact.id, before.id))
      .returning();
    await record(tx, userId, key, "edit", before, fields, now, proposedBy);
    return view(row!, now);
  }
  const [row] = await tx
    .insert(fact)
    .values({ id: uuidv7(), userId, key, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [fact.userId, fact.key] })
    .returning();
  if (!row) throw factKeyTaken();
  await record(tx, userId, key, "add", null, fields, now, proposedBy);
  return view(row, now);
}

/** Deletes a fact, and returns the log entry that says so. */
export async function deleteFact(
  { db, clock }: Context,
  userId: string,
  id: string,
): Promise<FactLogView> {
  const now = clock();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(fact)
      .where(and(eq(fact.id, id), eq(fact.userId, userId)))
      .returning();
    if (!row) throw factNotFound();
    return record(tx, userId, row.key, "delete", row, null, now);
  });
}

const logView = (row: typeof log.$inferSelect): FactLogView => ({
  id: row.id,
  key: row.key,
  action: row.action,
  old: snapshot(row.old),
  new: snapshot(row.new),
  proposedBy: row.proposedBy,
  at: row.at,
});

/** The owner's fact log, newest first. */
export async function listFactLog({ db }: Context, userId: string): Promise<FactLogView[]> {
  const rows = await db
    .select()
    .from(log)
    .where(eq(log.userId, userId))
    .orderBy(desc(log.at), desc(log.id))
    .limit(maxLogEntries);
  return rows.map(logView);
}

export async function exportFacts(tx: Transaction, userId: string) {
  const facts = await tx
    .select({
      key: fact.key,
      type: fact.type,
      topic: fact.topic,
      value: fact.value,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    })
    .from(fact)
    .where(eq(fact.userId, userId))
    .orderBy(asc(fact.topic), asc(fact.key));
  const entries = await tx
    .select({
      key: log.key,
      action: log.action,
      old: log.old,
      new: log.new,
      proposedBy: log.proposedBy,
      at: log.at,
    })
    .from(log)
    .where(eq(log.userId, userId))
    .orderBy(asc(log.at), asc(log.id));
  const proposals = await tx
    .select({
      key: proposal.key,
      botId: proposal.botId,
      proposed: proposal.proposed,
      why: proposal.why,
      postedAt: proposal.postedAt,
      expiresAt: proposal.expiresAt,
    })
    .from(proposal)
    .where(eq(proposal.userId, userId))
    .orderBy(asc(proposal.postedAt), asc(proposal.id));
  return { facts, factLog: entries, factProposals: proposals };
}

export async function deleteFacts(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(fact).where(eq(fact.userId, userId));
  await tx.delete(log).where(eq(log.userId, userId));
  await tx.delete(proposal).where(eq(proposal.userId, userId));
}
