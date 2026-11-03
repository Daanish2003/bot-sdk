import { toolDefinition } from "@tanstack/ai";
import { and, asc, eq, gt, lte, max, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext, FeatureTurn } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import { bot, message } from "@botsdk/bot/storage";
import {
  factAddInput,
  factKey,
  type FactProposalView,
  type FactView,
  noNul,
} from "../shared/contract";
import { factTypes } from "../shared/facts";
import { representativeFact, representativeFactProposal } from "./db/schema";
import { applyProposedFact, factOf, fieldsOf, logged } from "./facts";

/** When the Bot was last reset: anything it asked before then, it has forgotten. */
async function lastResetOf(tx: Transaction, botId: string) {
  const [mark] = await tx
    .select({ at: max(message.createdAt) })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(and(eq(bot.id, botId), eq(message.role, "reset")));
  return mark?.at ?? null;
}

/*
 * A Bot proposing a Published fact (ticket #1264). The tool only ever stores a proposal and posts the
 * card the core words: nothing changes a fact until the owner approves it on the Facts page. Approving
 * or declining wakes the Bot, a reset drops its proposals and wakes no one, and one past its 7 days can
 * no longer change the fact.
 */

type ProposeContext = Pick<
  FeatureContext<"factApprovals" | "threads">,
  "db" | "clock" | "jobs" | "factApprovals" | "threads"
>;
type ReadContext = Pick<ProposeContext, "db" | "clock">;

export const proposeFactToolName = "propose_fact";

const proposal = representativeFactProposal;

const proposalGone = () =>
  rpcError("CONFLICT", "error.factProposalGone", "That proposal is no longer waiting");

const dateField = z.iso.date().nullable().optional();

const proposeFactDefinition = toolDefinition({
  name: proposeFactToolName,
  description:
    "Propose adding or changing one of the user's Published facts: the exact prices, hours, phone " +
    "numbers and links their Representatives state. Nothing changes unless the user approves it on " +
    "the Facts page; if they answer within 7 days you are woken with the answer. A `key` that exists " +
    "changes that fact, with any field you don't name as it is now; a new `key` adds one and needs `type` and " +
    "`topic`. Values by type: money `45 USD`, hours `Mon-Fri 09:00-17:00; Sat closed`, phone " +
    "`+14155550100`, url `https://…`. One proposal waits per key.",
  inputSchema: z.object({
    key: z.string().describe("The fact's key: lower case, with dots, dashes and underscores."),
    value: z.string().refine(noNul),
    type: z.enum(factTypes).optional(),
    topic: z.string().refine(noNul).optional(),
    validFrom: dateField.describe("The day it starts (UTC), as YYYY-MM-DD; null for always."),
    validUntil: dateField.describe(
      "The day it stops, from that day's start (UTC), as YYYY-MM-DD; null for never.",
    ),
    /** What the card tells the user. */
    why: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .refine(noNul)
      .describe("Why you're proposing it, for the user."),
  }),
  // It changes something, so a read-only run refuses it.
  metadata: { readOnly: false },
});

const dateOf = (given: string | null | undefined, kept: Date | null) =>
  given === undefined ? kept : given === null ? null : new Date(`${given}T00:00:00Z`);

async function proposeFact(
  { db, clock, jobs, factApprovals, threads }: ProposeContext,
  { id: turnId, userId, botId }: FeatureTurn,
  input: z.output<typeof proposeFactDefinition.inputSchema>,
  toolCallId: string | undefined,
) {
  const key = factKey.safeParse(input.key);
  if (!key.success) return { error: "That isn't a valid fact key." };
  // A Provider may use a tool call's id again in another Turn, so the Turn's counts too.
  const call = toolCallId ? `${turnId}:${toolCallId}` : null;
  const saved = await db.transaction(async (tx) => {
    // Two proposals for one key go one at a time, so the check below can't race the other.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`representative_fact_proposal:${userId}:${key.data}`}))`,
    );
    const now = clock();
    await tx.delete(proposal).where(and(eq(proposal.userId, userId), lte(proposal.expiresAt, now)));
    const [waiting] = await tx
      .select({ call: proposal.call })
      .from(proposal)
      .where(and(eq(proposal.userId, userId), eq(proposal.key, key.data)));
    // This call's own card: it committed, and a crash lost the record of it, so this is a replay.
    if (waiting && call && waiting.call === call) return {};
    if (waiting) return { error: "A proposal for that key already waits for the user's answer." };

    const [current] = await tx
      .select()
      .from(representativeFact)
      .where(and(eq(representativeFact.userId, userId), eq(representativeFact.key, key.data)));
    const type = input.type ?? current?.type;
    const topic = input.topic ?? current?.topic;
    if (!type || !topic) return { error: "A new fact needs a `type` and a `topic`." };
    const parsed = factAddInput.safeParse({
      key: key.data,
      type,
      topic,
      value: input.value,
      validFrom: dateOf(input.validFrom, current?.validFrom ?? null),
      validUntil: dateOf(input.validUntil, current?.validUntil ?? null),
    });
    if (!parsed.success) {
      return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const proposed = logged(fieldsOf(parsed.data));
    if (current && JSON.stringify(logged(current)) === JSON.stringify(proposed)) {
      return { error: "That changes nothing in the fact." };
    }

    const card = await factApprovals.post(tx, {
      userId,
      botId,
      key: key.data,
      value: proposed.value,
      path: "/facts",
      why: input.why,
      turnId,
    });
    await tx.insert(proposal).values({
      id: uuidv7(),
      userId,
      botId,
      key: key.data,
      proposed,
      why: input.why,
      cardId: card.id,
      call,
      postedAt: now,
      expiresAt: card.expiresAt,
    });
    return { conversationId: card.conversationId };
  });
  if ("error" in saved) return saved;
  if (saved.conversationId) {
    jobs.wake();
    await threads.hintChanged(saved.conversationId);
  }
  return {
    saved:
      "Proposed. Nothing changes unless the user approves it on the Facts page, and you will be woken with the answer.",
  };
}

/** The proposal tool a Bot gets while the feature is on. A Representative's Turn is given none. */
export function factProposalTools(turn: FeatureTurn, context: ProposeContext) {
  return [
    proposeFactDefinition.server((input, call) =>
      proposeFact(context, turn, input, call?.toolCallId),
    ),
  ];
}

/** The proposals that still wait, oldest first, each beside the fact as it is now. */
export async function listFactProposals(
  { db, clock }: ReadContext,
  userId: string,
): Promise<FactProposalView[]> {
  const rows = await db
    .select({ row: proposal, botName: bot.name, current: representativeFact })
    .from(proposal)
    .innerJoin(bot, eq(bot.id, proposal.botId))
    .leftJoin(
      representativeFact,
      and(eq(representativeFact.userId, proposal.userId), eq(representativeFact.key, proposal.key)),
    )
    .where(and(eq(proposal.userId, userId), gt(proposal.expiresAt, clock())))
    .orderBy(asc(proposal.postedAt), asc(proposal.id));
  return rows.map(({ row, botName, current }) => ({
    id: row.id,
    key: row.key,
    botId: row.botId,
    botName,
    why: row.why,
    current: current && factOf(logged(current)),
    proposed: factOf(row.proposed),
    postedAt: row.postedAt,
    expiresAt: row.expiresAt,
  }));
}

/**
 * Answers the proposal `id`. It closes the card first, under its Conversation's lock, and only a card
 * that still waited lets the answer count: one expired or dropped by the Bot's reset can't change the
 * fact. A proposal whose card is past waiting is forgotten as it is refused.
 */
async function answerProposal<Result>(
  { db, clock, jobs, factApprovals, threads }: ProposeContext,
  userId: string,
  id: string,
  answer: "approved" | "declined",
  apply: (
    tx: Transaction,
    row: typeof proposal.$inferSelect,
    botName: string,
    now: Date,
  ) => Promise<Result>,
): Promise<Result> {
  const outcome = await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ row: proposal, botName: bot.name })
      .from(proposal)
      .innerJoin(bot, eq(bot.id, proposal.botId))
      .where(and(eq(proposal.id, id), eq(proposal.userId, userId)))
      .for("update", { of: proposal });
    if (!found) return null;
    const { row, botName } = found;
    await tx.delete(proposal).where(eq(proposal.id, id));
    const now = clock();
    // The reset's job drops it after the reset commits, maybe much later: until then it is as good as dropped.
    const reset = await lastResetOf(tx, row.botId);
    if (reset && row.postedAt <= reset) {
      const dropped = await factApprovals.drop(tx, { userId, id: row.cardId });
      return { gone: dropped?.conversationId ?? null };
    }
    const answered = await factApprovals.answer(tx, { userId, id: row.cardId, answer });
    if (!answered) return null;
    return {
      result: await apply(tx, row, botName, now),
      conversationId: answered.conversationId,
    };
  });
  if (!outcome) throw proposalGone();
  if ("gone" in outcome) {
    if (outcome.gone) await threads.hintChanged(outcome.gone);
    throw proposalGone();
  }
  jobs.wake();
  await threads.hintChanged(outcome.conversationId);
  return outcome.result;
}

export const approveFactProposal = (
  context: ProposeContext,
  userId: string,
  id: string,
): Promise<FactView> =>
  answerProposal(context, userId, id, "approved", (tx, row, botName, now) =>
    applyProposedFact(tx, userId, row.key, factOf(row.proposed), botName, now),
  );

export const declineFactProposal = (
  context: ProposeContext,
  userId: string,
  id: string,
): Promise<void> => answerProposal(context, userId, id, "declined", async () => undefined);

/**
 * A Bot reset drops the proposals it made and wakes no one. Safe to run again. It runs after the
 * reset's commit, maybe much later, so a card the Bot posted since the reset is left waiting.
 */
export async function dropProposalsOfBot(
  { db, factApprovals, threads }: Pick<ProposeContext, "db" | "factApprovals" | "threads">,
  botId: string,
  userId: string,
): Promise<void> {
  const dropped = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(proposal)
      .where(and(eq(proposal.userId, userId), eq(proposal.botId, botId)))
      .for("update");
    const reset = await lastResetOf(tx, botId);
    const conversations = new Set<string>();
    for (const row of rows) {
      if (reset && row.postedAt > reset) continue;
      const closed = await factApprovals.drop(tx, { userId, id: row.cardId });
      if (closed) conversations.add(closed.conversationId);
      await tx.delete(proposal).where(eq(proposal.id, row.id));
    }
    return conversations;
  });
  for (const conversationId of dropped) await threads.hintChanged(conversationId);
}
