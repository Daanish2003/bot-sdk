import { and, asc, desc, eq, max, notInArray } from "drizzle-orm";

import { endedAssignmentStatuses } from "@botsdk/client/bot/assignment";
import type { FeatureContext } from "@botsdk/bot/feature";
import { ORPCError } from "@orpc/contract";
import { rpcError } from "@botsdk/bot/rpc-error";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { bot, botAssignment } from "@botsdk/bot/storage";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  type Draft,
  type DraftChange,
  type DraftDiff,
  type ReleaseContent,
  type ReleaseSummary,
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
import { draftHash } from "./test-checks";
import { normalizedDraft, representativeTestJob, testStateOf } from "./tests";

type Context = Pick<FeatureContext, "db">;
type JobsContext = Pick<FeatureContext, "db" | "jobs">;
type MoveContext = FeatureContext<"assignments">;
type Row = typeof representative.$inferSelect;

/** What a new Representative's draft holds: no job text yet, no switches or Skills, every tool. */
export const emptyDraft = (): Draft => ({
  jobText: "",
  switches: {},
  skills: [],
  tools: [...representativeTools],
  model: null,
  tests: [],
});

const notFound = () =>
  rpcError("NOT_FOUND", "error.representativeNotFound", "Representative not found");

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

async function view(db: Context["db"] | Transaction, source: Row): Promise<RepresentativeView> {
  const row = { ...source, draft: normalizedDraft(source.draft) };
  const releases = await db
    .select({
      id: representativeRelease.id,
      number: representativeRelease.number,
      approvedAt: representativeRelease.approvedAt,
      overrideReason: representativeRelease.overrideReason,
      content: representativeRelease.content,
    })
    .from(representativeRelease)
    .where(eq(representativeRelease.representativeId, row.id))
    .orderBy(desc(representativeRelease.number));
  const live = releases.find((release) => release.id === row.liveReleaseId) ?? null;
  return {
    ...summaryOf(row, live?.number ?? null),
    draft: row.draft,
    liveRelease: live,
    releases: releases.map(({ id, number, approvedAt, overrideReason }): ReleaseSummary => ({
      id,
      number,
      approvedAt,
      overrideReason,
    })),
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
  { db }: Context,
  userId: string,
  id: string,
): Promise<RepresentativeView> {
  return view(db, await ownedRow(db, userId, id));
}

export async function createRepresentative(
  { db }: Context,
  userId: string,
  input: { name: string; botId?: string },
): Promise<RepresentativeView> {
  if (input.botId) {
    const [owned] = await db
      .select({ id: bot.id })
      .from(bot)
      .where(and(eq(bot.id, input.botId), eq(bot.userId, userId)))
      .limit(1);
    if (!owned) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  }
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
  return view(db, row!);
}

export async function updateDraft(
  { db }: Context,
  userId: string,
  id: string,
  changes: Partial<Draft>,
): Promise<RepresentativeView> {
  // Fields left out stay; one set to `undefined` doesn't clear its field.
  const defined = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  );
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    const [updated] = await tx
      .update(representative)
      .set({ draft: { ...row.draft, ...defined }, updatedAt: new Date() })
      .where(eq(representative.id, id))
      .returning();
    return view(tx, updated!);
  });
}

export async function setEnabled(
  { db }: Context,
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
    return view(tx, updated!);
  });
}

/**
 * Chooses the Bot a Representative reports to, one of the owner's, and moves its open hand-offs to
 * it, one by one through the Assignments service. Choosing again moves any that were left, so a
 * refusal part-way (the Bot's Model can't run) is retried by choosing the Bot again.
 */
export async function setBot(
  { db, assignments }: MoveContext,
  userId: string,
  id: string,
  botId: string,
): Promise<RepresentativeView> {
  const [owned] = await db
    .select({ id: bot.id })
    .from(bot)
    .where(and(eq(bot.id, botId), eq(bot.userId, userId)))
    .limit(1);
  if (!owned) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const updated = await db.transaction(async (tx) => {
    await ownedRow(tx, userId, id, true);
    const [row] = await tx
      .update(representative)
      .set({ botId, updatedAt: new Date() })
      .where(eq(representative.id, id))
      .returning();
    return row!;
  });
  const open = await db
    .select({ id: botAssignment.id })
    .from(representativeHandOff)
    .innerJoin(botAssignment, eq(botAssignment.id, representativeHandOff.assignmentId))
    .where(
      and(
        eq(representativeHandOff.representativeId, id),
        notInArray(botAssignment.status, endedAssignmentStatuses),
      ),
    )
    .orderBy(asc(botAssignment.createdAt), asc(botAssignment.id));
  for (const assignment of open) {
    try {
      await assignments.move({ userId, id: assignment.id, botId });
    } catch (error) {
      // One that ended since the read has nothing to move.
      const ended = error instanceof ORPCError && error.data?.code === "error.assignmentEnded";
      if (!ended) throw error;
    }
  }
  return view(db, updated);
}

/**
 * Runs the draft's test conversations, each on a job, and returns at once. Earlier results go: only
 * the draft as it is now has any. The jobs are queued in the transaction that records the results.
 */
export async function runTests(
  { db, jobs }: JobsContext,
  userId: string,
  id: string,
): Promise<RepresentativeView> {
  const started = await db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    await tx
      .delete(representativeTestResult)
      .where(eq(representativeTestResult.representativeId, id));
    const hash = draftHash(row.draft);
    for (const position of row.draft.tests.keys()) {
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
    return view(tx, row);
  });
  jobs.wake();
  return started;
}

/**
 * Pins the draft as the next numbered Release and points the Representative's live Release at it.
 * The Representative's row is locked, so two approvals never take one number. A draft whose tests
 * have failed, or haven't finished for the draft as it is now, needs `overrideReason`, which is
 * kept with the Release.
 */
export async function approveDraft(
  { db }: Context,
  userId: string,
  id: string,
  overrideReason?: string,
): Promise<ReleaseView> {
  return db.transaction(async (tx) => {
    const row = await ownedRow(tx, userId, id, true);
    if (row.draft.jobText.trim() === "") {
      throw rpcError(
        "BAD_REQUEST",
        "error.representativeJobTextBlank",
        "A Release needs job text: write what the Representative should do",
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
        content: structuredClone({ ...row.draft, documentSnapshot: null }),
        overrideReason: reason,
      })
      .returning();
    await tx
      .update(representative)
      .set({ liveReleaseId: release!.id, updatedAt: new Date() })
      .where(eq(representative.id, id));
    return {
      id: release!.id,
      number: release!.number,
      approvedAt: release!.approvedAt,
      overrideReason: release!.overrideReason,
      content: release!.content,
    };
  });
}

const asText = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

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
  add("jobText", null, live?.jobText ?? null, draft.jobText);
  add("model", null, live?.model ?? null, draft.model);
  const switches = [...Object.keys(live?.switches ?? {}), ...Object.keys(draft.switches)];
  for (const name of [...new Set(switches)].sort()) {
    add("switch", name, live?.switches[name], draft.switches[name]);
  }
  const [liveSkills, draftSkills] = [
    keyed(live?.skills ?? [], (skill) => skill.name),
    keyed(draft.skills, (skill) => skill.name),
  ];
  for (const name of new Set([...liveSkills.keys(), ...draftSkills.keys()])) {
    add("skill", name, liveSkills.get(name)?.text, draftSkills.get(name)?.text);
  }
  for (const tool of representativeTools) {
    add(
      "tool",
      tool,
      live?.tools.includes(tool) ? true : undefined,
      draft.tools.includes(tool) ? true : undefined,
    );
  }
  // Test conversations are named. A draft without the field isn't comparing them, so it shows no change.
  const draftTestList = (draft as { tests?: unknown[] }).tests;
  if (Array.isArray(draftTestList)) {
    const [liveTests, draftTests] = [
      keyed(live?.tests ?? [], testName),
      keyed(draftTestList, testName),
    ];
    for (const name of new Set([...liveTests.keys(), ...draftTests.keys()])) {
      add("test", name, liveTests.get(name), draftTests.get(name));
    }
  }
  return changes;
}

/** Items by name; a repeated name gets " (2)", " (3)"…, so none hides another. */
function keyed<T>(items: T[], nameOf: (item: T, index: number) => string) {
  const map = new Map<string, T>();
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const name = nameOf(item, index);
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    map.set(count === 1 ? name : `${name} (${count})`, item);
  });
  return map;
}

function testName(test: unknown, index: number) {
  const name = (test as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : `#${index + 1}`;
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
  { db }: Context,
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
    return view(tx, updated!);
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
  // The Releases go with them (their foreign key cascades).
  await tx.delete(representative).where(eq(representative.userId, userId));
}
