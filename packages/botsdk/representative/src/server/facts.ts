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
} from "./db/schema";

/*
 * The owner's Published facts (ticket #1258). Every read and write starts from the owner's id, and
 * a fact of someone else's is "not found", the same as one that doesn't exist. A change applies at
 * once, with no Release, and is logged in the same transaction. The clock is the SDK's, so which
 * facts are in effect, and when a change happened, can be moved by a test.
 */

type Context = Pick<FeatureContext, "db" | "clock">;

const fact = representativeFact;
const log = representativeFactLog;

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

const logged = (row: FactSnapshot): LoggedFact => ({
  type: row.type,
  topic: row.topic,
  value: row.value,
  validFrom: row.validFrom?.toISOString() ?? null,
  validUntil: row.validUntil?.toISOString() ?? null,
});

const snapshot = (stored: LoggedFact | null): FactSnapshot | null =>
  stored && {
    ...stored,
    validFrom: stored.validFrom ? new Date(stored.validFrom) : null,
    validUntil: stored.validUntil ? new Date(stored.validUntil) : null,
  };

async function record(
  tx: Transaction,
  userId: string,
  key: string,
  action: FactAction,
  old: FactSnapshot | null,
  next: FactSnapshot | null,
  at: Date,
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

const fieldsOf = (input: Fields): FactSnapshot => ({
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

/** Adds a fact, which is in effect at once; refused when the owner has the key already. */
export async function addFact(
  { db, clock }: Context,
  userId: string,
  input: Fields & { key: string },
): Promise<FactView> {
  const now = clock();
  const fields = fieldsOf(input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fact)
      .values({ id: uuidv7(), userId, key: input.key, ...fields, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [fact.userId, fact.key] })
      .returning();
    if (!row) throw factKeyTaken();
    await record(tx, userId, row.key, "add", null, fields, now);
    return view(row, now);
  });
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
  at: row.at,
});

/** The owner's fact log, newest first. */
export async function listFactLog({ db }: Context, userId: string): Promise<FactLogView[]> {
  const rows = await db
    .select()
    .from(log)
    .where(eq(log.userId, userId))
    .orderBy(desc(log.at), desc(log.id));
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
    .select({ key: log.key, action: log.action, old: log.old, new: log.new, at: log.at })
    .from(log)
    .where(eq(log.userId, userId))
    .orderBy(asc(log.at), asc(log.id));
  return { facts, factLog: entries };
}

export async function deleteFacts(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(fact).where(eq(fact.userId, userId));
  await tx.delete(log).where(eq(log.userId, userId));
}
