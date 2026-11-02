import { oc, type } from "@orpc/contract";
import { z } from "zod";

/*
 * The `representative` feature's contract (spec #1167): the owner's Representatives, their working
 * drafts and their Releases, served under `<basePath>/rpc/representative` and implemented by
 * `sdk.representative`'s methods of the same names. Public interface: the browser client is typed
 * by it, and it changes only with the package's semver.
 */

/**
 * The tools a Representative may have: a code-defined list, so no draft can give one a shell or a
 * new power. Later specs add to it.
 */
export const representativeTools = ["reply", "hand_to_bot"] as const;
export type RepresentativeTool = (typeof representativeTools)[number];

export const maxJobTextLength = 20_000;
export const maxSkills = 50;
export const maxSkillTextLength = 20_000;
export const maxTestConversations = 20;
export const maxExpectations = 20;
export const maxOverrideReasonLength = 1_000;

/** A Skill copied into a draft: a read-only procedure that grants no permission. */
export const skillCopySchema = z.object({
  name: z.string().trim().min(1).max(100),
  text: z.string().max(maxSkillTextLength),
});

/**
 * What code checks about a test conversation: the list is closed and has no model judge. `said` and
 * `not_said` look for the text in what the Representative sent the Customer, ignoring case.
 */
export const expectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replied") }),
  z.object({ kind: z.literal("handed_off") }),
  z.object({ kind: z.literal("not_handed_off") }),
  z.object({ kind: z.literal("said"), text: z.string().trim().min(1).max(500) }),
  z.object({ kind: z.literal("not_said"), text: z.string().trim().min(1).max(500) }),
]);
export type Expectation = z.output<typeof expectationSchema>;

/** A scripted test conversation: what a stand-in Customer says, and what must hold afterwards. */
export const testConversationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** The stand-in Customer's message. */
  message: z.string().trim().min(1).max(4_000),
  expect: z.array(expectationSchema).min(1).max(maxExpectations),
});
export type TestConversation = z.output<typeof testConversationSchema>;

/** What the owner writes: the part of a Release that is theirs to edit. */
export const draftSchema = z.object({
  /** What the Representative is told to do. */
  jobText: z.string().max(maxJobTextLength),
  /** The owner's switches, which code checks; the SDK defines none yet. */
  switches: z.record(z.string().min(1).max(64), z.boolean()),
  skills: z.array(skillCopySchema).max(maxSkills),
  /** Only names from `representativeTools`, each once. */
  tools: z
    .array(z.enum(representativeTools))
    .refine((tools) => new Set(tools).size === tools.length, "A tool is listed once"),
  /** The Model, `"provider:model"`, or null for the Host's default. */
  model: z.string().trim().min(1).max(200).nullable(),
  /** Scripted test conversations, run on the draft and pinned in the Release. */
  tests: z.array(testConversationSchema).max(maxTestConversations),
});
export type Draft = z.output<typeof draftSchema>;

/**
 * What a Release pins: the owner's draft, with its test conversations, and the document snapshot
 * reference (empty until the Knowledge spec).
 */
export type ReleaseContent = Draft & { documentSnapshot: null };

export type ReleaseSummary = {
  id: string;
  number: number;
  approvedAt: Date;
  /** Why the owner approved with tests failed or unfinished; null when the tests allowed it. */
  overrideReason: string | null;
};
export type ReleaseView = ReleaseSummary & { content: ReleaseContent };

export type RepresentativeSummary = {
  id: string;
  name: string;
  /** The Bot it reports to; null reports to the owner. */
  botId: string | null;
  enabled: boolean;
  /** The number of the live Release, or null before the first approval. */
  liveReleaseNumber: number | null;
};

/** One line of a test conversation's transcript. */
export type TranscriptEntry = {
  role: "customer" | "representative" | "tool" | "system";
  text: string;
};

/** One expectation, and whether code found it held. */
export type TestCheck = { expectation: Expectation; passed: boolean; detail: string };

export type TestResultStatus = "queued" | "running" | "passed" | "failed" | "error";

/** One test conversation's result on the draft as it is now. */
export type TestResultView = {
  position: number;
  name: string;
  status: TestResultStatus;
  transcript: TranscriptEntry[];
  checks: TestCheck[];
  /** Why a test that couldn't finish ended; null otherwise. */
  error: string | null;
};

/**
 * Where the draft's tests stand: `none` when it has no test conversations, `notRun` when it has
 * results for none of them as the draft is now, `running`, `failed` (a failure or an error, even
 * while others run) or `passed`. Only `none` and `passed` let Approve through.
 */
export type TestStatus = "none" | "notRun" | "running" | "failed" | "passed";

export type RepresentativeView = RepresentativeSummary & {
  draft: Draft;
  liveRelease: ReleaseView | null;
  releases: ReleaseSummary[];
  testStatus: TestStatus;
  /** The results that count for the draft as it is now: none once it has changed. */
  tests: TestResultView[];
};

/**
 * One difference between the draft and the live Release. `before` and `after` are the two sides as
 * text, and null where that side has none (a Skill or switch only one side holds, a first Release).
 */
export type DraftChange = {
  field: "jobText" | "switch" | "skill" | "tool" | "model" | "test";
  /** The switch, Skill, tool or test the change is about; null for the job text and Model. */
  name: string | null;
  before: string | null;
  after: string | null;
};

export type DraftDiff = {
  /** The Release compared against; null before the first approval, when everything is new. */
  liveReleaseNumber: number | null;
  changes: DraftChange[];
};

export const idInput = z.object({ id: z.uuid() });
export const approveInput = z.object({
  id: z.uuid(),
  /** Approve anyway: why, when the tests failed or haven't finished. Logged with the Release. */
  overrideReason: z.string().max(maxOverrideReasonLength).optional(),
});
export const rollbackInput = z.object({ id: z.uuid(), releaseId: z.uuid() });
export const createInput = z.object({
  name: z.string().trim().min(1).max(100),
  botId: z.uuid().optional(),
});
export const updateDraftInput = z.object({
  id: z.uuid(),
  draft: draftSchema.partial(),
});
export const setEnabledInput = z.object({ id: z.uuid(), enabled: z.boolean() });
export const setBotInput = z.object({ id: z.uuid(), botId: z.uuid() });

export const representativeContract = {
  /** The owner's Representatives, oldest first. */
  list: oc.output(type<RepresentativeSummary[]>()),
  /** One Representative with its draft, live Release and every Release's number. */
  get: oc.input(idInput).output(type<RepresentativeView>()),
  /** Creates a Representative with an empty draft, reporting to one of the owner's Bots or to none. */
  create: oc.input(createInput).output(type<RepresentativeView>()),
  /** Changes fields of the draft. The live Release stays as it is. */
  updateDraft: oc.input(updateDraftInput).output(type<RepresentativeView>()),
  /** Runs the draft's test conversations on a job, replacing earlier results, and returns at once. */
  runTests: oc.input(idInput).output(type<RepresentativeView>()),
  /**
   * Pins the draft as the next numbered Release and makes it live. Refused while its tests have
   * failed or haven't finished, unless `overrideReason` says why not.
   */
  approve: oc.input(approveInput).output(type<ReleaseView>()),
  /** What the draft changes against the live Release, so the owner reviews only that. */
  diff: oc.input(idInput).output(type<DraftDiff>()),
  /** Repoints the live Release to an earlier one of this Representative, with no test and no new Release. */
  rollback: oc.input(rollbackInput).output(type<RepresentativeView>()),
  /** Switches the Representative on or off, with no new Release. */
  setEnabled: oc.input(setEnabledInput).output(type<RepresentativeView>()),
  /** Chooses which of the owner's Bots it reports to; its open Assignments move to that Bot. */
  setBot: oc.input(setBotInput).output(type<RepresentativeView>()),
};

export type RepresentativeContract = typeof representativeContract;
