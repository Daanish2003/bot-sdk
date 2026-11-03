import { and, desc, eq, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import { type FactView, type GapView, maxGapQuestionLength } from "../shared/contract";
import { insertFact } from "./facts";
import { representativeGap } from "./db/schema";

/*
 * The owner's Gaps (ticket #1263): the questions a Representative couldn't confirm from any source.
 * Every read and write starts from the owner's id, and a Gap of someone else's is "not found". A
 * Gap is logged by a Turn's reply, in that reply's transaction, and an owner closes it by
 * dismissing it or by turning it into a fact. Only an open Gap is counted again.
 */

type Context = Pick<FeatureContext, "db" | "clock">;

const gap = representativeGap;

const gapNotFound = () => rpcError("NOT_FOUND", "error.gapNotFound", "Gap not found");

/** A question as it is compared: case, spacing and punctuation don't tell two apart. */
export const normalizeQuestion = (question: string) =>
  question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The most open Gaps the owner is shown. */
const maxListed = 200;

/** `text` cut to the question limit in whole characters, never inside a surrogate pair. */
const cut = (text: string) => [...text].slice(0, maxGapQuestionLength).join("");

const view = (row: typeof gap.$inferSelect): GapView => ({
  id: row.id,
  question: row.question,
  count: row.count,
  representativeId: row.representativeId,
  firstAt: row.firstAt,
  lastAt: row.lastAt,
});

/**
 * Logs that `representativeId` couldn't confirm `question` for `userId`: a new open Gap, or one
 * more on the owner's open Gap with the same normalized text. A question with nothing to compare
 * (no letter or digit) logs nothing.
 */
export async function logGap(
  tx: Transaction,
  {
    userId,
    representativeId,
    question,
    now,
  }: {
    userId: string;
    representativeId: string;
    question: string;
    now: Date;
  },
): Promise<void> {
  question = cut(question.trim());
  const normalized = cut(normalizeQuestion(question));
  if (normalized === "") return;
  await tx
    .insert(gap)
    .values({
      id: uuidv7(),
      userId,
      representativeId,
      question,
      normalized,
      firstAt: now,
      lastAt: now,
    })
    .onConflictDoUpdate({
      target: [gap.userId, gap.normalized],
      targetWhere: sql`${gap.status} = 'open'`,
      set: {
        count: sql`${gap.count} + 1`,
        lastAt: sql`greatest(${gap.lastAt}, ${now.toISOString()}::timestamp)`,
      },
    });
}

/** The owner's open Gaps, the most recently asked first. */
export async function listGaps({ db }: Context, userId: string): Promise<GapView[]> {
  const rows = await db
    .select()
    .from(gap)
    .where(and(eq(gap.userId, userId), eq(gap.status, "open")))
    .orderBy(desc(gap.lastAt), desc(gap.id))
    .limit(maxListed);
  return rows.map(view);
}

/** Closes an open Gap as `status`, or says it isn't there. */
async function close(
  tx: Transaction,
  userId: string,
  id: string,
  status: "dismissed" | "answered",
  now: Date,
) {
  const [row] = await tx
    .update(gap)
    .set({ status, closedAt: now })
    .where(and(eq(gap.id, id), eq(gap.userId, userId), eq(gap.status, "open")))
    .returning();
  if (!row) throw gapNotFound();
  return row;
}

export async function dismissGap({ db, clock }: Context, userId: string, id: string) {
  const now = clock();
  return view(await db.transaction((tx) => close(tx, userId, id, "dismissed", now)));
}

/** Adds the fact and closes the Gap together: a refused fact leaves the Gap open. */
export async function gapToFact(
  { db, clock }: Context,
  userId: string,
  { id, ...input }: Parameters<typeof insertFact>[2] & { id: string },
): Promise<FactView> {
  const now = clock();
  return db.transaction(async (tx) => {
    // The Gap first, so a closed or foreign one is "not found" whatever the key; a refused key rolls it back.
    await close(tx, userId, id, "answered", now);
    return insertFact(tx, userId, input, now);
  });
}

export async function exportGaps(tx: Transaction, userId: string) {
  const gaps = await tx
    .select({
      question: gap.question,
      count: gap.count,
      status: gap.status,
      representativeId: gap.representativeId,
      firstAt: gap.firstAt,
      lastAt: gap.lastAt,
      closedAt: gap.closedAt,
    })
    .from(gap)
    .where(eq(gap.userId, userId))
    .orderBy(gap.firstAt, gap.id);
  return { gaps };
}

export async function deleteGaps(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(gap).where(eq(gap.userId, userId));
}
