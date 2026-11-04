import { and, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { approvalExpiryMs } from "@botsdk/client/bot/review";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { factAddInput, factKey, noNul } from "../shared/contract";
import { factTypes } from "../shared/facts";
import {
  representativeCustomerIdentity,
  representativeFact,
  representativeFactProposal,
  representativeProfileValue,
} from "./db/schema";
import { fieldsOf, logged } from "./facts";

/*
 * A lesson the Customer memory pass proposes from a closed thread (ticket #1289, ADR 0035): a
 * Published fact with no identity in it. It is a fact proposal with no Bot, so it shows on the Facts
 * page only, and answering it wakes no one. It records neither the Customer nor the thread it came
 * from. Code refuses the shapes and values that would identify a Customer; past that, the owner who
 * reads it is the check.
 */

/** What the log says proposed an approved lesson. */
export const lessonProposer = "Customer memory pass";

const defaultWhy = "Seen across your Customers' conversations.";

const lessonShape = z.object({
  key: factKey,
  type: z.enum(factTypes),
  topic: z.string(),
  value: z.string(),
  why: z.string().trim().max(1_000).refine(noNul).optional(),
});

export type Lesson = {
  key: string;
  type: (typeof factTypes)[number];
  topic: string;
  value: string;
  why: string;
};

/** Reads the Model's JSON object for a lesson. Anything else, or a fact that doesn't fit its type, gives none. */
export function parseLesson(text: string): Lesson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  const shape = lessonShape.safeParse(parsed);
  if (!shape.success) return null;
  const { why, ...fields } = shape.data;
  const fact = factAddInput.safeParse(fields);
  if (!fact.success) return null;
  const { key, type, topic, value } = fact.data;
  return { key, type, topic, value, why: why || defaultWhy };
}

const emailShape = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Seven digits or more, with only the separators a number is written with between them.
const phoneShape = /(?:\+?\d[\s().-]*){7,}/;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `value` stands in `text` as a whole word or phrase, whatever its case. */
const mentions = (text: string, value: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** Whether a lesson names or could reach a Customer: a phone or email shape, or a value `known` of theirs. */
export function identifiesCustomer(lesson: Lesson, known: string[]) {
  const text = [lesson.key, lesson.topic, lesson.value, lesson.why].join("\n");
  if (emailShape.test(text) || phoneShape.test(text)) return true;
  return known.some((value) => value.trim() !== "" && mentions(text, value.trim()));
}

/**
 * Stores the lesson as a proposal for the owner's Facts page, when it passes: it has no identity in
 * it, no proposal waits for the same key, and it changes a fact. The caller holds the thread, and
 * writes the Customer's profile values first, so they are among the values the lesson is checked
 * against. `customerId` is read here and never stored.
 */
export async function proposeLesson(
  tx: Transaction,
  {
    userId,
    customerId,
    now,
    lesson,
  }: { userId: string; customerId: string; now: Date; lesson: Lesson },
) {
  const profile = await tx
    .select({ value: representativeProfileValue.value })
    .from(representativeProfileValue)
    .where(eq(representativeProfileValue.customerId, customerId));
  const addresses = await tx
    .select({ value: representativeCustomerIdentity.externalId })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.customerId, customerId));
  if (
    identifiesCustomer(
      lesson,
      [...profile, ...addresses].map(({ value }) => value),
    )
  )
    return;

  const proposal = representativeFactProposal;
  // The same lock a Bot's proposal takes, so two proposals for one key go one at a time.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`representative_fact_proposal:${userId}:${lesson.key}`}))`,
  );
  await tx.delete(proposal).where(and(eq(proposal.userId, userId), lte(proposal.expiresAt, now)));
  const [waiting] = await tx
    .select({ id: proposal.id })
    .from(proposal)
    .where(and(eq(proposal.userId, userId), eq(proposal.key, lesson.key)));
  if (waiting) return;
  const [current] = await tx
    .select()
    .from(representativeFact)
    .where(and(eq(representativeFact.userId, userId), eq(representativeFact.key, lesson.key)));
  const proposed = logged(
    fieldsOf({ type: lesson.type, topic: lesson.topic, value: lesson.value }),
  );
  if (current && JSON.stringify(logged(current)) === JSON.stringify(proposed)) {
    return;
  }
  await tx.insert(proposal).values({
    id: uuidv7(),
    userId,
    botId: null,
    key: lesson.key,
    proposed,
    why: lesson.why,
    cardId: null,
    call: null,
    postedAt: now,
    expiresAt: new Date(now.getTime() + approvalExpiryMs),
  });
}
