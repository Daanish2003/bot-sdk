import { and, asc, desc, eq, max, ne, notInArray, sql } from "drizzle-orm";

import { endedAssignmentStatuses } from "@botsdk/client/bot/assignment";
import { isLiveListProvider, parseModelId } from "@botsdk/client/models/models";
import type { FeatureContext } from "@botsdk/bot/feature";
import { rpcError } from "@botsdk/bot/rpc-error";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { bot, botAssignment, message } from "@botsdk/bot/storage";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  documentChars,
  type Draft,
  type DraftChange,
  type DraftDiff,
  maxReleaseDocumentChars,
  type PendingApproval,
  type ReleaseContent,
  type ReleaseView,
  type RepresentativeSummary,
  type RepresentativeView,
  representativeTools,
} from "../shared/contract";
import {
  representative,
  representativeHandOff,
  representativeRelease,
  representativeTestResult,
} from "./db/schema";
import {
  chooseDocument,
  type ConvertDocument,
  dropDocument,
  exportDocuments,
  type KnowledgeFiles,
  knowledgeText,
  readableText,
  snapshotOf,
} from "./documents";
import { botFieldsHash, draftHash } from "./test-checks";
import { normalizedDraft, representativeTestJob, testStateOf } from "./tests";
import { isAssignmentEnded } from "./turn";

type Context = Pick<FeatureContext, "db" | "clock">;
type JobsContext = Pick<FeatureContext, "db" | "clock" | "jobs">;
/** What answers a Bot's Approval. */
type AnswerContext = Pick<
  FeatureContext<"releaseApprovals" | "threads">,
  "db" | "clock" | "jobs" | "releaseApprovals" | "threads"
>;
type MoveContext = Pick<
  FeatureContext<"assignments" | "releaseApprovals" | "threads">,
  "db" | "clock" | "logger" | "assignments" | "releaseApprovals" | "threads"
>;
type ApproveContext = AnswerContext & Pick<FeatureContext<"models">, "models">;
type Row = typeof representative.$inferSelect;

/**
 * What a new Representative's draft holds: no job text yet, no switches or Skills, and the tools
 * every Representative needs. `verify_customer` sends codes people pay for and receive, so a Release
 * has it only by choosing it (ticket #1256).
 */
export const emptyDraft = (): Draft => ({
  jobText: "",
  switches: {},
  skills: [],
  tools: ["reply", "hand_to_bot", "read_customer_work"],
  model: null,
  tests: [],
  documents: [],
});

const notFound = () =>
  rpcError("NOT_FOUND", "error.representativeNotFound", "Representative not found");

/** `approval` while it still waits for the owner at `now`, else null. */
export function waitingApproval(approval: PendingApproval | null, now: Date) {
  return approval && new Date(approval.expiresAt) > now ? approval : null;
}

/**
 * Whether the owner can use `model`: the Models they can pick are the ones that can run. A
 * live-listed Provider whose list came back empty says nothing about the Model, as its list may just
 * have failed: credentials for it are as much as can be known.
 */
export async function modelUsable(
  models: ApproveContext["models"],
  userId: string,
  model: string,
): Promise<boolean> {
  const { models: usable } = await models.listAvailableModels(userId);
  if (usable.some((each) => each.id === model)) return true;
  const provider = parseModelId(model)?.provider;
  if (!provider || !isLiveListProvider(provider)) return false;
  if (usable.some((each) => each.provider === provider)) return false;
  return (await models.resolveModelCall(userId, model)) !== null;
}

const modelUnavailable = (model: string) =>
  rpcError(
    "BAD_REQUEST",
    "error.representativeModelUnavailable",
    `"${model}" is not a Model you can use`,
  );

/** Refuses a Bot that isn't one of the owner's, the same as one that doesn't exist. */
async function requireOwnedBot(db: Context["db"], userId: string, botId: string) {
  const [owned] = await db
    .select({ id: bot.id })
    .from(bot)
    .where(and(eq(bot.id, botId), eq(bot.userId, userId)))
    .limit(1);
  if (!owned) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
}

/** The owner's row, or a not-found that is the same for a row that doesn't exist and another owner's. */
async function ownedRow(db: Context["db"] | Transaction, userId: string, id: string, lock = false) {
  const query = db
    .select()
    .from(representative)
    .where(and(eq(representative.id, id), eq(representative.userId, userId)))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound();
  return { ...row, draft: normalizedDraft(row.draft) };
}

async function view(
  db: Context["db"] | Transaction,
  source: Row,
  now: Date,
): Promise<RepresentativeView> {
  const row = { ...source, draft: normalizedDraft(source.draft) };
  const releases = await db
    .select({
      id: representativeRelease.id,
      number: representativeRelease.number,
      approvedAt: representativeRelease.approvedAt,
      overrideReason: representativeRelease.overrideReason,
    })
    .from(representativeRelease)
    .where(eq(representativeRelease.representativeId, row.id))
    .orderBy(desc(representativeRelease.number));
  const [content] = row.liveReleaseId
    ? await db
        .select({ content: representativeRelease.content })
        .from(representativeRelease)
        .where(eq(representativeRelease.id, row.liveReleaseId))
    : [];
  const live = releases.find((release) => release.id === row.liveReleaseId);
  const waiting = waitingApproval(row.pendingApproval, now);
  return {
    ...summaryOf(row, live?.number ?? null),
    draft: row.draft,
    approval: waiting && { botId: waiting.botId, expiresAt: waiting.expiresAt },
    liveRelease: live && content ? { ...live, ...content } : null,
    releases,
    ...(await testStateOf(db, row)),
  };
}

function summaryOf(row: Row, liveReleaseNumber: number | null): RepresentativeSummary {
  return {
    id: row.id,
    name: row.name,
    botId: row.botId,
    enabled: row.enabled,
    liveReleaseNumber,
  };
}

export async function listRepresentatives(
  { db }: Context,
  userId: string,
): Promise<RepresentativeSummary[]> {
  const rows = await db
    .select({
      row: representative,
      liveReleaseNumber: representativeRelease.number,
    })
    .from(representative)
    .leftJoin(representativeRelease, eq(representativeRelease.id, representative.liveReleaseId))
    .where(eq(representative.userId, userId))
    .orderBy(asc(representative.createdAt), asc(representative.id));
  return rows.map(({ row, liveReleaseNumber }) => summaryOf(row, liveReleaseNumber));
}

export async function getRepresentative(
  { db, clock }: Context,
  userId: string,
  id: string,
): Promise<RepresentativeView> {
  return view(db, await ownedRow(db, userId, id), clock());
}

export async function createRepresentative(
  { db, clock }: Context,
  userId: string,
  input: { name: string; botId?: string },
): Promise<RepresentativeView> {
  if (input.botId) await requireOwnedBot(db, userId, input.botId);
  const [row] = await db
    .insert(representative)
    .values({
      id: uuidv7(),
      userId,
      botId: input.botId ?? null,
      name: input.name,
      draft: emptyDraft(),
    })
    .returning();
  return view(db, row!, clock());
}

/** `draft` with `changes`: fields left out stay, and one set to `undefined` doesn't clear its field. */
export function mergedDraft(draft: Draft, changes: Partial<Draft>): Draft {
  return {
    ...draft,
    ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
  };
}

export async function updateDraft(
  { db, clock }: Context,
  userId: string,
  id: string,
  changes: Partial<Draft>,
): Promise<RepresentativeView> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    const [updated] = await tx
      .update(representative)
      .set({ draft: mergedDraft(row.draft, changes), updatedAt: new Date() })
      .where(eq(representative.id, id))
      .returning();
    return view(tx, updated!, clock());
  });
}

/**
 * Adds a document to the draft: its text is read before any lock, as a PDF may take a while, then
 * copied in with no Computer. Tests that ran on the draft as it was stop counting by its hash.
 */
export async function uploadDocument(
  { db, clock }: Context,
  userId: string,
  id: string,
  file: File,
  convert?: ConvertDocument,
): Promise<RepresentativeView> {
  // Asked first, so nobody's file is read for a Representative that isn't theirs.
  await ownedRow(db, userId, id);
  const document = { name: file.name, text: await readableText(file, convert) };
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    return saveDocuments(tx, row, await chooseDocument(tx, row, document, clock()), clock());
  });
}

/**
 * Copies a Knowledge file's text into the draft, as an upload would. The Computer is asked before the
 * transaction, so an unreachable one leaves the draft as it was and holds no row.
 */
export async function pickKnowledgeDocument(
  { db, clock }: Context,
  userId: string,
  id: string,
  path: string,
  files: KnowledgeFiles | undefined,
): Promise<RepresentativeView> {
  // Asked first, so nobody's Computer is woken for a Representative that isn't theirs.
  await ownedRow(db, userId, id);
  const document = await knowledgeText(files, userId, path);
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    return saveDocuments(tx, row, await chooseDocument(tx, row, document, clock()), clock());
  });
}

/** Takes a document out of the draft. A Release that holds it keeps it. */
export async function removeDocument(
  { db, clock }: Context,
  userId: string,
  id: string,
  documentId: string,
): Promise<RepresentativeView> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    return saveDocuments(tx, row, await dropDocument(tx, row, documentId), clock());
  });
}

async function saveDocuments(
  tx: Transaction,
  row: Row,
  documents: Draft["documents"],
  now: Date,
): Promise<RepresentativeView> {
  const [updated] = await tx
    .update(representative)
    .set({ draft: { ...row.draft, documents }, updatedAt: now })
    .where(eq(representative.id, row.id))
    .returning();
  return view(tx, updated!, now);
}

export async function setEnabled(
  { db, clock }: Context,
  userId: string,
  id: string,
  enabled: boolean,
): Promise<RepresentativeView> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    // A Representative serves only through an approved Release, so it can be switched on only once one is live.
    if (enabled && row.liveReleaseId === null) {
      throw rpcError(
        "BAD_REQUEST",
        "error.representativeNoRelease",
        "Approve a Release before switching the Representative on",
      );
    }
    const [updated] = await tx
      .update(representative)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(representative.id, id))
      .returning();
    return view(tx, updated!, clock());
  });
}

/** Moves the Representative's open hand-offs that aren't on `botId` to it, one by one, and stops at a refusal. */
async function moveHandOffs(
  { db, assignments }: Pick<MoveContext, "db" | "assignments">,
  userId: string,
  id: string,
  botId: string,
) {
  const open = await db
    .select({ id: botAssignment.id })
    .from(representativeHandOff)
    .innerJoin(botAssignment, eq(botAssignment.id, representativeHandOff.assignmentId))
    .where(
      and(
        eq(representativeHandOff.representativeId, id),
        ne(botAssignment.assignedBotId, botId),
        notInArray(botAssignment.status, endedAssignmentStatuses),
      ),
    )
    .orderBy(asc(botAssignment.createdAt), asc(botAssignment.id));
  for (const assignment of open) {
    await assignments.move({ userId, id: assignment.id, botId }).catch((error: unknown) => {
      // One that ended since the read has nothing to move.
      if (!isAssignmentEnded(error)) throw error;
    });
  }
}

/**
 * Chooses the Bot a Representative reports to, one of the owner's. Its open hand-offs move first, so
 * a refusal (the Bot's Model can't run) leaves it on the old Bot, and choosing again moves any left.
 * A hand-off made meanwhile moves after the choice stands: its Turn either saw the new Bot, or has
 * written its hand-off by the second look. An Approval the old Bot's draft waits on is dropped: the
 * old Bot no longer answers for this Representative, and the new one must be able to draft.
 */
export async function setBot(
  context: MoveContext,
  userId: string,
  id: string,
  botId: string,
): Promise<RepresentativeView> {
  const { db, clock, logger, releaseApprovals, threads } = context;
  await requireOwnedBot(db, userId, botId);
  await ownedRow(db, userId, id);
  await moveHandOffs(context, userId, id, botId);
  const { updated, dropped } = await db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    const dropping = row.pendingApproval !== null && row.pendingApproval.botId !== botId;
    const dropped = dropping
      ? await releaseApprovals.drop(tx, { userId, id: row.pendingApproval!.id })
      : null;
    const [updated] = await tx
      .update(representative)
      .set({
        botId,
        updatedAt: new Date(),
        ...(dropping && { pendingApproval: null }),
      })
      .where(eq(representative.id, id))
      .returning();
    return { updated: updated!, dropped };
  });
  if (dropped) await threads.hintChanged(dropped.conversationId);
  // The choice stands by now, so a refusal here is no refusal of it. Whichever choice came last wins.
  const { botId: chosen } = await ownedRow(db, userId, id);
  await moveHandOffs(context, userId, id, chosen ?? botId).catch((error: unknown) => {
    logger.error(`Representative ${id}: a hand-off made during the choice stays put`, error);
  });
  return view(db, updated, clock());
}

/**
 * Queues the draft's test conversations, each on a job. Earlier results go: only the draft as it is
 * now has any. The jobs are queued in the transaction that records the results.
 */
export async function queueTests(
  tx: Transaction,
  jobs: JobsContext["jobs"],
  { id, draft }: { id: string; draft: Draft },
): Promise<void> {
  await tx
    .delete(representativeTestResult)
    .where(eq(representativeTestResult.representativeId, id));
  const hash = draftHash(draft);
  for (const position of draft.tests.keys()) {
    const resultId = uuidv7();
    await tx.insert(representativeTestResult).values({
      id: resultId,
      representativeId: id,
      draftHash: hash,
      position,
      status: "queued",
      transcript: [],
      checks: [],
    });
    await jobs.enqueueIn(tx, representativeTestJob, { resultId });
  }
}

/** Runs the draft's test conversations and returns at once. */
export async function runTests(
  { db, jobs, clock }: JobsContext,
  userId: string,
  id: string,
): Promise<RepresentativeView> {
  const started = await db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    await queueTests(tx, jobs, { id, draft: row.draft });
    return view(tx, row, clock());
  });
  jobs.wake();
  return started;
}

/**
 * Pins the draft as the next numbered Release and points the Representative's live Release at it.
 * The Representative's row is locked, so two approvals never take one number. A draft whose tests
 * have failed, or haven't finished for the draft as it is now, needs `overrideReason`, which is
 * kept with the Release. A Model the owner can't use is refused whatever the reason, as it would
 * end every Turn, and so are documents past the cap, which the owner must choose between. Approving
 * reads no document: the draft's references are frozen, and their rows never change. A Bot's Approval
 * waiting on the draft is answered, which wakes that Bot.
 */
export async function approveDraft(
  { db, jobs, models, releaseApprovals, threads }: ApproveContext,
  userId: string,
  id: string,
  overrideReason?: string,
): Promise<ReleaseView> {
  // Asked before the row's lock is taken, as a live-listed Provider's list may mean a slow fetch.
  const { draft: asked } = await ownedRow(db, userId, id);
  if (asked.model !== null && !(await modelUsable(models, userId, asked.model))) {
    throw modelUnavailable(asked.model);
  }
  const { result, answered } = await db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    // Saved since the question above: it wasn't asked about this one.
    if (row.draft.model !== asked.model && row.draft.model !== null) {
      throw modelUnavailable(row.draft.model);
    }
    if (row.draft.jobText.trim() === "") {
      throw rpcError(
        "BAD_REQUEST",
        "error.representativeJobTextBlank",
        "A Release needs job text: write what the Representative should do",
      );
    }
    const chars = documentChars(row.draft.documents);
    if (chars > maxReleaseDocumentChars) {
      throw rpcError(
        "BAD_REQUEST",
        "error.representativeDocumentsTooLong",
        "The draft's documents are over the limit for a Release: remove some",
        { chars, limit: maxReleaseDocumentChars },
      );
    }
    const { testStatus } = await testStateOf(tx, row);
    let reason: string | null = null;
    if (testStatus !== "none" && testStatus !== "passed") {
      if (overrideReason === undefined) {
        throw testStatus === "failed"
          ? rpcError(
              "BAD_REQUEST",
              "error.representativeTestsFailed",
              "A test has failed: fix the draft, or approve anyway with a reason",
            )
          : rpcError(
              "BAD_REQUEST",
              "error.representativeTestsUnfinished",
              "The tests haven't finished for this draft: run them, or approve anyway with a reason",
            );
      }
      reason = overrideReason.trim();
      if (reason === "") {
        throw rpcError(
          "BAD_REQUEST",
          "error.representativeOverrideReason",
          "Approving anyway needs a reason",
        );
      }
    }
    const { documents, ...fields } = row.draft;
    const [last] = await tx
      .select({ latest: max(representativeRelease.number) })
      .from(representativeRelease)
      .where(eq(representativeRelease.representativeId, id));
    const [release] = await tx
      .insert(representativeRelease)
      .values({
        id: uuidv7(),
        representativeId: id,
        number: (last?.latest ?? 0) + 1,
        content: structuredClone({ ...fields, documentSnapshot: snapshotOf(documents) }),
        overrideReason: reason,
      })
      .returning();
    await tx
      .update(representative)
      .set({ liveReleaseId: release!.id, pendingApproval: null, updatedAt: new Date() })
      .where(eq(representative.id, id));
    const answered =
      row.pendingApproval &&
      (await releaseApprovals.answer(tx, {
        userId,
        id: row.pendingApproval.id,
        answer: "approved",
        releaseNumber: release!.number,
        edited:
          row.botDraftHash !== botFieldsHash(row.draft) ||
          row.pendingApproval.documentsHash !== snapshotOf(documents)?.hash,
      }));
    return {
      answered,
      result: {
        id: release!.id,
        number: release!.number,
        approvedAt: release!.approvedAt,
        overrideReason: release!.overrideReason,
        content: release!.content,
      },
    };
  });
  if (answered) {
    jobs.wake();
    await threads.hintChanged(answered.conversationId);
  }
  return result;
}

/**
 * The owner's no to the Approval waiting on the draft: it wakes the Bot, and the draft stays. A card
 * that turns out not to wait after all (it went with its Conversation) is forgotten as it is refused,
 * so the page stops offering a no it can't take.
 */
export async function declineApproval(
  { db, clock, jobs, releaseApprovals, threads }: AnswerContext,
  userId: string,
  id: string,
): Promise<RepresentativeView> {
  const { result, answered } = await db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    const now = clock();
    const waiting = waitingApproval(row.pendingApproval, now);
    const answered =
      waiting &&
      (await releaseApprovals.answer(tx, { userId, id: waiting.id, answer: "declined" }));
    if (!answered && !row.pendingApproval) return { answered, result: null };
    const [updated] = await tx
      .update(representative)
      .set({ pendingApproval: null, updatedAt: now })
      .where(eq(representative.id, id))
      .returning();
    return { answered, result: await view(tx, updated!, now) };
  });
  if (!answered || !result) {
    throw rpcError(
      "CONFLICT",
      "error.representativeNoApproval",
      "There is no Approval waiting on this draft",
    );
  }
  jobs.wake();
  await threads.hintChanged(answered.conversationId);
  return result;
}

/**
 * A Bot reset drops the Approvals its drafts wait on, and keeps the drafts, the Representatives and
 * their Releases. Safe to run again. It runs after the reset's commit, maybe much later, so a card
 * the Bot posted since the reset is left waiting.
 */
export async function dropApprovalsOfBot(
  { db, releaseApprovals, threads }: Pick<AnswerContext, "db" | "releaseApprovals" | "threads">,
  botId: string,
  userId: string,
): Promise<void> {
  const dropped = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: representative.id, pendingApproval: representative.pendingApproval })
      .from(representative)
      .where(
        and(
          eq(representative.userId, userId),
          sql`${representative.pendingApproval}->>'botId' = ${botId}`,
        ),
      )
      .for("update");
    const [mark] = await tx
      .select({ at: max(message.createdAt) })
      .from(message)
      .innerJoin(bot, eq(bot.conversationId, message.conversationId))
      .where(and(eq(bot.id, botId), eq(message.role, "reset")));
    const conversations = new Set<string>();
    for (const row of rows) {
      const { postedAt } = row.pendingApproval!;
      if (mark?.at && postedAt && new Date(postedAt) > mark.at) continue;
      const closed = await releaseApprovals.drop(tx, { userId, id: row.pendingApproval!.id });
      if (closed) conversations.add(closed.conversationId);
      await tx
        .update(representative)
        .set({ pendingApproval: null })
        .where(eq(representative.id, row.id));
    }
    return conversations;
  });
  for (const conversationId of dropped) await threads.hintChanged(conversationId);
}

/** A side of a change as text; null is a side that has none. */
const asText = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

/** The draft's differences from `live`, field by field. Equal parts leave nothing. */
export function draftChanges(draft: Draft, live: ReleaseContent | null): DraftChange[] {
  const changes: DraftChange[] = [];
  const add = (
    field: DraftChange["field"],
    name: string | null,
    before: unknown,
    after: unknown,
  ) => {
    if (asText(before) !== asText(after)) {
      changes.push({ field, name, before: asText(before), after: asText(after) });
    }
  };
  add("jobText", null, live?.jobText, draft.jobText);
  add("model", null, live?.model, draft.model);
  const switches = [...Object.keys(live?.switches ?? {}), ...Object.keys(draft.switches)];
  for (const name of [...new Set(switches)].sort()) {
    add("switch", name, live?.switches[name], draft.switches[name]);
  }
  /** Each item changed, added or removed by name, then those on both sides put in another order. */
  const addNamed = <T>(
    field: DraftChange["field"],
    liveItems: Map<string, T>,
    draftItems: Map<string, T>,
    side: (item: T | undefined) => unknown,
  ) => {
    for (const name of new Set([...liveItems.keys(), ...draftItems.keys()])) {
      add(field, name, side(liveItems.get(name)), side(draftItems.get(name)));
    }
    return () =>
      add(
        field,
        null,
        [...liveItems.keys()].filter((name) => draftItems.has(name)),
        [...draftItems.keys()].filter((name) => liveItems.has(name)),
      );
  };
  const skillOrder = addNamed(
    "skill",
    keyed(live?.skills ?? []),
    keyed(draft.skills),
    (skill) => skill?.text,
  );
  for (const tool of representativeTools) {
    add(
      "tool",
      tool,
      live?.tools.includes(tool) ? true : undefined,
      draft.tools.includes(tool) ? true : undefined,
    );
  }
  const testOrder = addNamed("test", keyed(live?.tests ?? []), keyed(draft.tests), (test) => test);
  const documentOrder = addNamed(
    "document",
    keyed(live?.documentSnapshot?.documents ?? []),
    keyed(draft.documents),
    (document) => document && `${document.chars} characters (${document.hash.slice(0, 8)})`,
  );
  skillOrder();
  testOrder();
  documentOrder();
  return changes;
}

/** Items by name; a repeated name gets " (2)", " (3)"…, past any taken, so none hides another. */
function keyed<T extends { name: string }>(items: T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    let key = item.name;
    for (let count = 2; map.has(key); count++) key = `${item.name} (${count})`;
    map.set(key, item);
  }
  return map;
}

/** What the draft changes against the live Release (everything, before the first Release). */
export async function diffDraft({ db }: Context, userId: string, id: string): Promise<DraftDiff> {
  const row = await ownedRow(db, userId, id);
  const [live] = row.liveReleaseId
    ? await db
        .select({ number: representativeRelease.number, content: representativeRelease.content })
        .from(representativeRelease)
        .where(eq(representativeRelease.id, row.liveReleaseId))
    : [];
  return {
    liveReleaseNumber: live?.number ?? null,
    changes: draftChanges(row.draft, live?.content ?? null),
  };
}

/**
 * Repoints the live Release to an earlier Release of this Representative: no test, no new Release,
 * and the draft stays. A Turn that has started holds its own Release, so only later Turns see it.
 */
export async function rollbackRelease(
  { db, clock }: Context,
  userId: string,
  id: string,
  releaseId: string,
): Promise<RepresentativeView> {
  return db.transaction(async (tx) => {
    await ownedRow(tx, userId, id, true);
    // Another Representative's Release is not found, the same as one that doesn't exist.
    const [target] = await tx
      .select({ id: representativeRelease.id })
      .from(representativeRelease)
      .where(
        and(
          eq(representativeRelease.id, releaseId),
          eq(representativeRelease.representativeId, id),
        ),
      );
    if (!target) {
      throw rpcError("NOT_FOUND", "error.releaseNotFound", "Release not found");
    }
    const [updated] = await tx
      .update(representative)
      .set({ liveReleaseId: releaseId, updatedAt: new Date() })
      .where(eq(representative.id, id))
      .returning();
    return view(tx, updated!, clock());
  });
}

/** The owner's Representatives and their Releases, for the export. */
export async function exportRepresentatives(tx: Transaction, userId: string) {
  const rows = await tx
    .select()
    .from(representative)
    .where(eq(representative.userId, userId))
    .orderBy(asc(representative.createdAt), asc(representative.id));
  const exported = [];
  for (const row of rows) {
    const releases = await tx
      .select()
      .from(representativeRelease)
      .where(eq(representativeRelease.representativeId, row.id))
      .orderBy(asc(representativeRelease.number));
    const testResults = await tx
      .select()
      .from(representativeTestResult)
      .where(eq(representativeTestResult.representativeId, row.id))
      .orderBy(asc(representativeTestResult.position));
    exported.push({
      id: row.id,
      name: row.name,
      botId: row.botId,
      enabled: row.enabled,
      liveReleaseId: row.liveReleaseId,
      draft: row.draft,
      documents: await exportDocuments(tx, row.id),
      pendingApproval: row.pendingApproval,
      createdAt: row.createdAt,
      testResults: testResults.map(
        ({ position, status, transcript, checks, error, createdAt }) => ({
          position,
          status,
          transcript,
          checks,
          error,
          createdAt,
        }),
      ),
      releases: releases.map(({ id, number, content, approvedAt, overrideReason }) => ({
        id,
        number,
        content,
        approvedAt,
        overrideReason,
      })),
    });
  }
  return exported;
}

export async function deleteRepresentatives(tx: Transaction, userId: string): Promise<void> {
  // The Releases and the documents' text go with them (their foreign keys cascade).
  await tx.delete(representative).where(eq(representative.userId, userId));
}
