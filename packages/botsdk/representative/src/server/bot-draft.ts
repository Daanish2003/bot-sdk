import { toolDefinition } from "@tanstack/ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext, FeatureTurn } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { type Draft, draftSchema, noNul, type PendingApproval } from "../shared/contract";
import { representative, representativeRelease } from "./db/schema";
import {
  emptyDraft,
  mergedDraft,
  modelUsable,
  queueTests,
  waitingApproval,
} from "./representatives";
import { botFieldsHash, draftHash } from "./test-checks";
import { normalizedDraft, testStateOf } from "./tests";

/*
 * A Bot drafting a Representative (ticket #1195), through deferred tools. A draft takes the path an
 * owner's takes: its tests run and the owner approves it on the Representative's page, which the card
 * the core posts links to. Nothing here writes a Release, the live Release or on/off. A Bot's Skills
 * and Custom Rules reach it as text the Bot passes in, because a feature never calls another.
 */

type DraftContext = Pick<
  FeatureContext<"models" | "releaseApprovals" | "threads">,
  "db" | "clock" | "jobs" | "models" | "releaseApprovals" | "threads"
>;

export const draftToolName = "draft_representative";
export const listToolName = "list_representatives";

const draftInput = draftSchema
  .pick({ jobText: true, skills: true, tools: true, model: true, tests: true })
  .partial();

const draftToolDefinition = toolDefinition({
  name: draftToolName,
  description:
    "Draft a Representative, a restricted agent that speaks to the user's Customers, for the user's " +
    "Approval: give `name` and `jobText` to create one that reports to you, or `representativeId` to " +
    "change one that does, naming only the fields to change; its name is the user's. Its `tests` run " +
    "on the draft. It goes live only if the user approves it on its page; if they answer within 7 " +
    "days you are woken with the answer. You can't change what is live or a draft the user has " +
    "edited, and you have one draft waiting at a time. To carry over one of your Skills " +
    "or Custom Rules, read it and pass its procedure as text in `skills`: a copy that grants the " +
    "Representative nothing, whose `tools` come only from the fixed list.",
  inputSchema: z.object({
    representativeId: z.uuid().optional(),
    name: z.string().trim().min(1).max(100).refine(noNul).optional(),
    /** What the card tells the user. */
    why: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .refine(noNul)
      .describe("Why you're proposing it, for the user."),
    ...draftInput.shape,
  }),
  // It changes something, so a read-only run refuses it.
  metadata: { readOnly: false },
});

const listToolDefinition = toolDefinition({
  name: listToolName,
  description:
    "List the Representatives that report to you, with their ids and live Release numbers, or give `id` to read one's whole draft.",
  inputSchema: z.object({ id: z.uuid().optional() }),
  metadata: { readOnly: true },
});

const ownerEditsError =
  "The user has edited this draft and hasn't approved it: ask them before you change it.";
const waitError =
  "You already have a draft waiting for the user's answer: wait for it before you draft again.";

/** One Bot's drafts go one at a time, so the check below can't race its own second call. */
const lockBotDrafts = (tx: Transaction, botId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"representative_draft:" + botId}))`);

/**
 * Whether the owner has no edit of their own in `draft` to lose: it is what a Bot last wrote, the
 * live Release's, or the empty one a new Representative starts with. Documents don't count: a Bot
 * can't choose them, and its draft keeps the owner's choice.
 */
async function onlyTheBotEdited(
  tx: Transaction,
  row: Pick<typeof representative.$inferSelect, "botDraftHash" | "liveReleaseId">,
  draft: Draft,
) {
  const hash = botFieldsHash(draft);
  if (hash === row.botDraftHash) return true;
  if (!row.liveReleaseId) return hash === botFieldsHash(emptyDraft());
  const [live] = await tx
    .select({ content: representativeRelease.content })
    .from(representativeRelease)
    .where(eq(representativeRelease.id, row.liveReleaseId));
  if (!live) return false;
  const { documentSnapshot: _pinned, ...content } = live.content;
  return hash === botFieldsHash(normalizedDraft({ ...content, documents: [] }));
}

async function draftFromBot(
  context: DraftContext,
  turn: FeatureTurn,
  { representativeId, name, why, ...changes }: z.output<typeof draftToolDefinition.inputSchema>,
  toolCallId: string | undefined,
) {
  const { db, clock, jobs, models, releaseApprovals, threads } = context;
  const { userId, botId } = turn;
  if (changes.model && !(await modelUsable(models, userId, changes.model))) {
    return { error: `"${changes.model}" is not a Model the user can use.` };
  }
  const saved = await db.transaction(async (tx) => {
    await lockBotDrafts(tx, botId);
    const now = clock();
    const own = await tx
      .select({ id: representative.id, pendingApproval: representative.pendingApproval })
      .from(representative)
      .where(
        and(
          eq(representative.userId, userId),
          sql`${representative.pendingApproval}->>'botId' = ${botId}`,
        ),
      );
    const waiting = own.find((row) => waitingApproval(row.pendingApproval, now));
    // This call's own card: it committed, and a crash lost the record of it, so this is a replay.
    // A Provider may use a tool call's id again in another Turn, so the Turn's counts too.
    const call = toolCallId && `${turn.id}:${toolCallId}`;
    if (waiting && call && waiting.pendingApproval!.call === call) return { id: waiting.id };
    if (waiting) return { error: waitError };

    const blank = (draft: Draft) => draft.jobText.trim() === "";
    const blankError = "A draft needs `jobText`.";

    let id = representativeId;
    let shownName = name;
    let draft: Draft;
    let unchanged = false;
    if (id) {
      if (name !== undefined) return { error: "A Representative's name is the user's to change." };
      // Only one that reports to this Bot: any other is not found, the same as one that doesn't exist.
      const [row] = await tx
        .select()
        .from(representative)
        .where(
          and(
            eq(representative.id, id),
            eq(representative.userId, userId),
            eq(representative.botId, botId),
          ),
        )
        .for("update");
      if (!row) return { error: "No Representative of that id reports to you." };
      if (waitingApproval(row.pendingApproval, now)) return { error: waitError };
      shownName = row.name;
      const before = normalizedDraft(row.draft);
      if (!(await onlyTheBotEdited(tx, row, before))) return { error: ownerEditsError };
      draft = mergedDraft(before, changes);
      if (blank(draft)) return { error: blankError };
      // A card that expired can be asked again; otherwise there is nothing new to ask about.
      unchanged = draftHash(draft) === draftHash(before);
      if (!row.pendingApproval && unchanged) {
        return { error: "That changes nothing in the draft." };
      }
    } else {
      if (!name) return { error: "A new Representative needs a `name`." };
      draft = mergedDraft(emptyDraft(), changes);
      if (blank(draft)) return { error: blankError };
      id = uuidv7();
      await tx.insert(representative).values({ id, userId, botId, name, draft });
    }

    const card = await releaseApprovals.post(tx, {
      userId,
      botId,
      representativeId: id,
      representativeName: shownName!,
      path: `/representatives/${id}`,
      why,
      turnId: turn.id,
    });
    const pendingApproval: PendingApproval = {
      id: card.id,
      botId,
      expiresAt: card.expiresAt.toISOString(),
      postedAt: now.toISOString(),
      ...(call && { call }),
    };
    await tx
      .update(representative)
      .set({ draft, pendingApproval, botDraftHash: botFieldsHash(draft), updatedAt: now })
      .where(eq(representative.id, id));
    // Asking again about the draft as it was needs no new run: its results still count.
    const known = unchanged && (await testStateOf(tx, { id, draft })).testStatus !== "notRun";
    if (!known) await queueTests(tx, jobs, { id, draft });
    return { id, conversationId: card.conversationId };
  });
  if ("error" in saved) return saved;
  if (saved.conversationId) {
    jobs.wake();
    await threads.hintChanged(saved.conversationId);
  }
  return {
    saved:
      "Drafted. Its tests are running. It goes live only if the user approves it on its page, and you will be woken with the answer.",
    representativeId: saved.id,
  };
}

/** The Representatives that report to the Turn's Bot in short, or the whole of one with `id`. */
async function listForBot(
  { db, clock }: Pick<DraftContext, "db" | "clock">,
  turn: FeatureTurn,
  { id }: { id?: string },
) {
  const rows = await db
    .select({ row: representative, liveReleaseNumber: representativeRelease.number })
    .from(representative)
    .leftJoin(representativeRelease, eq(representativeRelease.id, representative.liveReleaseId))
    .where(
      and(
        eq(representative.userId, turn.userId),
        eq(representative.botId, turn.botId),
        id ? eq(representative.id, id) : undefined,
      ),
    )
    .orderBy(asc(representative.createdAt), asc(representative.id));
  if (id && rows.length === 0) return { error: "No Representative of that id reports to you." };
  const now = clock();
  return {
    representatives: rows.map(({ row, liveReleaseNumber }) => ({
      id: row.id,
      name: row.name,
      liveReleaseNumber,
      waitingForApproval: waitingApproval(row.pendingApproval, now) !== null,
      ...(id && { draft: normalizedDraft(row.draft) }),
    })),
  };
}

/** The tools a Bot gets while the feature is on. A Representative's Turn is given none of them. */
export function botDraftTools(turn: FeatureTurn, context: DraftContext) {
  return [
    draftToolDefinition.server((input, call) =>
      draftFromBot(context, turn, input, call?.toolCallId),
    ),
    listToolDefinition.server((input) => listForBot(context, turn, input)),
  ];
}
