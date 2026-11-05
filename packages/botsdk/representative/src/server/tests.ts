import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { defineJob } from "@botsdk/bot/runner/internal";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  type Draft,
  documentChars,
  maxReleaseDocumentChars,
  type TestResultView,
  type TestStatus,
  normalizedRelease,
} from "../shared/contract";
import { representative, representativeTestResult } from "./db/schema";
import { DocumentGone, type DocumentText, readDocuments } from "./documents";
import { checkExpectations, draftHash, transcriptOf } from "./test-checks";
import { hostDefaultModel, playLoop, type TurnServices } from "./turn";

/*
 * A draft's test conversations (ticket #1192). Each runs as a job of its own on the draft, as a
 * Representative Turn does on a Release, with the Release's tools stubbed so none reaches anything
 * real, and with the Model calls recorded as `representative` usage on the owner's Quota. Code then
 * checks each expectation. A result counts only while the draft still hashes as it did when it ran.
 */

export const representativeTestJobName = "representative.test";

/** At most this many test conversations run at once in one process, apart from live Turns' budget. */
const testConcurrency = 4;

const payload = z.object({ resultId: z.uuid() });
type TestPayload = z.infer<typeof payload>;

type Db = FeatureContext["db"] | Transaction;

/** The draft as stored: a draft written before test conversations, documents or the emergency script has none. */
export const normalizedDraft = (draft: Draft): Draft => ({
  ...normalizedRelease(draft),
  tests: draft.tests ?? [],
  documents: draft.documents ?? [],
});

/** Where `row`'s draft stands on its tests, and the results that count for it as it is now. */
export async function testStateOf(
  db: Db,
  row: { id: string; draft: Draft },
): Promise<{ testStatus: TestStatus; tests: TestResultView[] }> {
  const conversations = row.draft.tests;
  if (conversations.length === 0) return { testStatus: "none", tests: [] };
  const results = await db
    .select()
    .from(representativeTestResult)
    .where(
      and(
        eq(representativeTestResult.representativeId, row.id),
        eq(representativeTestResult.draftHash, draftHash(row.draft)),
      ),
    )
    .orderBy(asc(representativeTestResult.position));
  const tests = results.flatMap((result): TestResultView[] => {
    const conversation = conversations[result.position];
    if (!conversation) return [];
    return [
      {
        position: result.position,
        name: conversation.name,
        status: result.status,
        transcript: result.transcript,
        checks: result.checks,
        error: result.error,
      },
    ];
  });
  if (tests.length !== conversations.length) return { testStatus: "notRun", tests: [] };
  const testStatus = tests.some((test) => test.status === "failed" || test.status === "error")
    ? "failed"
    : tests.some((test) => test.status === "queued" || test.status === "running")
      ? "running"
      : "passed";
  return { testStatus, tests };
}

/**
 * What `resultId` is for, if it is still for the draft as it is now. A result that isn't goes: it
 * would never count, and mustn't count if the draft comes back.
 */
async function currentResult({ db }: Pick<TurnServices, "db">, resultId: string) {
  const [row] = await db
    .select({
      representativeId: representative.id,
      userId: representative.userId,
      name: representative.name,
      draft: representative.draft,
      draftHash: representativeTestResult.draftHash,
      position: representativeTestResult.position,
    })
    .from(representativeTestResult)
    .innerJoin(representative, eq(representative.id, representativeTestResult.representativeId))
    .where(eq(representativeTestResult.id, resultId));
  if (!row) return null;
  const draft = normalizedDraft(row.draft);
  const conversation = draft.tests[row.position];
  if (!conversation || draftHash(draft) !== row.draftHash) {
    await db.delete(representativeTestResult).where(eq(representativeTestResult.id, resultId));
    return null;
  }
  return {
    userId: row.userId,
    representativeId: row.representativeId,
    name: row.name,
    draft,
    conversation,
  };
}

/** The conversation `resultId` is for, marked running, if it is still for the draft as it is now. */
async function readTest(services: TurnServices, resultId: string) {
  const current = await currentResult(services, resultId);
  if (!current) return null;
  const model = current.draft.model ?? (await hostDefaultModel(services.models, current.userId));
  await services.db
    .update(representativeTestResult)
    .set({ status: "running" })
    .where(eq(representativeTestResult.id, resultId));
  return { ...current, model: model ?? null };
}

type Outcome = Pick<typeof representativeTestResult.$inferInsert, "status" | "error"> &
  Partial<Pick<typeof representativeTestResult.$inferInsert, "transcript" | "checks">>;

const write = ({ db }: TurnServices, resultId: string, outcome: Outcome) =>
  db.update(representativeTestResult).set(outcome).where(eq(representativeTestResult.id, resultId));

/** What a test conversation stopped by a Ban says. */
export const testBanned = "The owner is banned";

/** The job of a test conversation's result, by which a Ban cancels it. */
export const representativeTestKey = (resultId: string) =>
  `${representativeTestJobName}:${resultId}`;

/** One test conversation's job: plays it on the draft with stubbed tools, then checks it. */
export const representativeTestJob = defineJob<TestPayload, TurnServices>({
  name: representativeTestJobName,
  payload,
  concurrency: testConcurrency,
  // A retry may yet finish, so only the job's end says a result will never come.
  onFailed: async ({ resultId }, error, { db }) => {
    await db
      .update(representativeTestResult)
      .set({ status: "error", error: error instanceof Error ? error.message : String(error) })
      .where(
        and(
          eq(representativeTestResult.id, resultId),
          inArray(representativeTestResult.status, ["queued", "running"]),
        ),
      );
  },
  run: async ({ resultId }, job) => {
    const start = await job.step("representative_test_start", () => readTest(job, resultId));
    if (!start) return;
    if (!start.model) {
      await write(job, resultId, { status: "error", error: "No Model the owner can use" });
      return;
    }
    const { userId, representativeId, name, draft, conversation, model } = start;
    // A test conversation spends as a Turn does, so a Ban stops it too (ticket #1299). Recorded, so a
    // replay goes the way this one did.
    const banned = await job.step("representative_test_ban", () => job.isUserBlocked(userId));
    if (banned) {
      await write(job, resultId, { status: "error", error: testBanned });
      return;
    }
    // It could never be approved, so it costs the owner nothing to find out what it would do.
    if (documentChars(draft.documents) > maxReleaseDocumentChars) {
      await write(job, resultId, {
        status: "error",
        error: "The draft's documents are over the limit for a Release",
      });
      return;
    }
    const current = async () => (await currentResult(job, resultId)) !== null;
    let documents: DocumentText[];
    try {
      documents = await readDocuments(job.db, draft.documents);
    } catch (caught) {
      if (!(caught instanceof DocumentGone)) throw caught;
      await write(job, resultId, {
        status: "error",
        error: "A document of the draft changed while this waited",
      });
      return;
    }
    const played = await playLoop(job, {
      userId,
      representativeId,
      customerId: resultId,
      name,
      model,
      sourceId: resultId,
      on: { test: { current } },
      entries: [{ author: "customer", text: conversation.message, verified: true }],
      content: draft,
      documents,
    });
    // The draft changed or a new run replaced it, so what this came to has nowhere to go.
    if (!(await current())) return;
    const transcript = transcriptOf(conversation.message, played.transcript, played.testRun);
    const reason = played.quotaSpent
      ? "The owner's Quota is spent"
      : played.error !== undefined
        ? played.error
        : played.timedOut
          ? "The conversation ran out of time"
          : played.stepLimit
            ? "The conversation used all its Steps"
            : undefined;
    if (reason !== undefined) {
      await write(job, resultId, { status: "error", error: reason, transcript });
      return;
    }
    const checks = checkExpectations(conversation.expect, played.transcript, played.testRun);
    await write(job, resultId, {
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      error: null,
      transcript,
      checks,
    });
  },
});
