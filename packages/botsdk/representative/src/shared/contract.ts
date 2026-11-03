import { oc, type } from "@orpc/contract";
import { z } from "zod";

import { checkFactValue, factTypes, type FactType } from "./facts";

export { factTypes, isInEffect, type FactType } from "./facts";

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
export const representativeTools = ["reply", "hand_to_bot", "verify_customer"] as const;
export type RepresentativeTool = (typeof representativeTools)[number];

export const maxJobTextLength = 20_000;
export const maxSkills = 50;
export const maxSkillTextLength = 20_000;
export const maxTestConversations = 20;
export const maxExpectations = 20;
export const maxOverrideReasonLength = 1_000;
export const maxSwitches = 100;

/** Whether `text` can be stored: Postgres takes no NUL in text or jsonb. */
export const noNul = (text: string) => !text.includes("\u0000");
const noNulMessage = "NUL characters are not allowed";
const storable = <Schema extends z.ZodString>(schema: Schema) => schema.refine(noNul, noNulMessage);

/** `value` with every object's keys in order, so equal drafts print equal whatever order Postgres kept. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, each]) => [key, canonical(each)]),
    );
  }
  return value;
}

/** `value` as JSON that is the same for equal values, whatever order their keys came in. */
export const canonicalJson = (value: unknown) => JSON.stringify(canonical(value));

/** A Skill copied into a draft: a read-only procedure that grants no permission. */
export const skillCopySchema = z.object({
  name: storable(z.string().trim().min(1).max(100)),
  text: storable(z.string().max(maxSkillTextLength)),
});

/**
 * What code checks about a test conversation: the list is closed and has no model judge. `said` and
 * `not_said` look for the text in what the Representative sent the Customer, ignoring case.
 */
export const expectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replied") }),
  z.object({ kind: z.literal("handed_off") }),
  z.object({ kind: z.literal("not_handed_off") }),
  z.object({ kind: z.literal("said"), text: storable(z.string().trim().min(1).max(500)) }),
  z.object({ kind: z.literal("not_said"), text: storable(z.string().trim().min(1).max(500)) }),
]);
export type Expectation = z.output<typeof expectationSchema>;

/** A scripted test conversation: what a stand-in Customer says, and what must hold afterwards. */
export const testConversationSchema = z.object({
  name: storable(z.string().trim().min(1).max(100)),
  /** The stand-in Customer's message. */
  message: storable(z.string().trim().min(1).max(4_000)),
  expect: z.array(expectationSchema).min(1).max(maxExpectations),
});
export type TestConversation = z.output<typeof testConversationSchema>;

/** What the owner writes: the part of a Release that is theirs to edit. */
export const draftSchema = z.object({
  /** What the Representative is told to do. */
  jobText: storable(z.string().max(maxJobTextLength)),
  /** The owner's switches, which code checks; the SDK defines none yet. */
  switches: z
    .record(storable(z.string().min(1).max(64)), z.boolean())
    .refine((switches) => Object.keys(switches).length <= maxSwitches, "Too many switches"),
  skills: z.array(skillCopySchema).max(maxSkills),
  /** Only names from `representativeTools`, each once. */
  tools: z
    .array(z.enum(representativeTools))
    .refine((tools) => new Set(tools).size === tools.length, "A tool is listed once"),
  /** The Model, `"provider:model"`, or null for the Host's default. */
  model: storable(z.string().trim().min(1).max(200)).nullable(),
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

/**
 * A Bot's draft waiting for the owner: the core's card in that Bot's Conversation, when it was
 * posted, until when, and the call that posted it (its Turn's id and tool call's), so a replay of
 * that call knows its own.
 */
export type PendingApproval = {
  id: string;
  botId: string;
  expiresAt: string;
  postedAt?: string;
  call?: string;
};

export type RepresentativeView = RepresentativeSummary & {
  draft: Draft;
  /** The Approval waiting on this draft; null once answered, dropped or past its 7 days. */
  approval: Pick<PendingApproval, "botId" | "expiresAt"> | null;
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
  /**
   * The switch, Skill, tool or test the change is about; null for the job text and Model, and for
   * Skills or tests put in another order, whose sides are then their names in order.
   */
  name: string | null;
  before: string | null;
  after: string | null;
};

export type DraftDiff = {
  /** The Release compared against; null before the first approval, when everything is new. */
  liveReleaseNumber: number | null;
  changes: DraftChange[];
};

/** One way of reaching a Customer: a Channel, that Channel's id for them, and whether it is verified now. */
export type CustomerIdentityView = {
  id: string;
  channel: string;
  externalId: string;
  verified: boolean;
};

/** One of the owner's Customers, shared by all their Representatives. */
export type CustomerView = {
  id: string;
  /** What the owner calls them; null until they say. */
  name: string | null;
  /** Whether the owner blocked them: a blocked Customer's message runs no Turn and gets no reply. */
  blocked: boolean;
  identities: CustomerIdentityView[];
  createdAt: Date;
};

/** One merge of a Customer into another, and whether it has been undone. */
export type CustomerMergeView = {
  id: string;
  /** Whether a code the sender passed made it, or the owner. */
  how: "code" | "owner";
  survivor: { id: string; name: string | null };
  absorbed: { id: string; name: string | null };
  /** What moved, and what undoing it gives back. */
  identities: { channel: string; externalId: string }[];
  createdAt: Date;
  undoneAt: Date | null;
};

/** Who holds a Customer thread: its Representative, the owner who took it over, or no one once closed. */
export type ThreadHolder = "representative" | "owner" | "closed";

/**
 * Who a thread is waiting on, derived from who holds it and who spoke last: the Customer after an
 * answer, and after a Customer's message the Representative, or the owner while they hold it. The
 * Bot, in place of the Customer, while an Assignment handed off from the thread is open. Null
 * once closed, while its Customer is blocked, whose message nobody answers, or when no Turn is on
 * its way to the last word on a thread its Representative holds.
 */
export type ThreadWaitingOn = "customer" | "representative" | "owner" | "bot" | null;

export type ThreadSummary = {
  id: string;
  customer: { id: string; name: string | null; blocked: boolean };
  /** Where the Customer was last heard from, which is where a reply goes. */
  lastHeard: { channel: string; externalId: string };
  holder: ThreadHolder;
  waitingOn: ThreadWaitingOn;
  messageCount: number;
  updatedAt: Date;
};

/** One message of a thread's transcript, with where it was heard from or sent to. */
export type ThreadMessageView = {
  id: string;
  author: "customer" | "representative" | "owner" | "note" | "bot";
  text: string;
  channel: string;
  externalId: string;
  /** Whether the Turn it belongs to was for a verified sender. */
  verified: boolean;
  createdAt: Date;
};

export type ThreadView = ThreadSummary & {
  representativeId: string;
  /** The Customer's identities, each with whether it is verified. */
  identities: CustomerIdentityView[];
  /** Oldest first. */
  messages: ThreadMessageView[];
};

/** The longest one thread message may be, whoever wrote it. */
export const maxThreadMessageLength = 60_000;

export const threadSendInput = z.object({
  id: z.uuid(),
  text: storable(z.string().trim().min(1).max(maxThreadMessageLength)),
});

export const maxCustomerNameLength = 100;
/** Channel ids are lower case, so `SMS` and `sms` are one Channel. */
const channelField = storable(z.string().trim().toLowerCase().min(1).max(64));
const externalIdField = storable(z.string().trim().min(1).max(512));
export const customerCreateInput = z.object({
  name: storable(z.string().trim().min(1).max(maxCustomerNameLength)).optional(),
  channel: channelField,
  externalId: externalIdField,
});
export const customerAddIdentityInput = z.object({
  id: z.uuid(),
  channel: channelField,
  externalId: externalIdField,
});
export const customerUpdateIdentityInput = z.object({
  id: z.uuid(),
  identityId: z.uuid(),
  channel: channelField,
  externalId: externalIdField,
});
export const customerSetBlockedInput = z.object({ id: z.uuid(), blocked: z.boolean() });
export const customerMergeInput = z.object({ id: z.uuid(), intoId: z.uuid() });
export const customerRenameInput = z.object({
  id: z.uuid(),
  name: storable(z.string().trim().max(maxCustomerNameLength)),
});

/** The fields of a Published fact that don't name it, as stored or logged. */
export type FactSnapshot = {
  type: FactType;
  topic: string;
  value: string;
  validFrom: Date | null;
  validUntil: Date | null;
};

/** One of the owner's Published facts. `inEffect` is whether its valid dates cover now. */
export type FactView = FactSnapshot & {
  id: string;
  key: string;
  inEffect: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** One change to a fact: `old` is null for an add, and `new` for a delete. */
export type FactLogView = {
  id: string;
  key: string;
  action: "add" | "edit" | "delete";
  old: FactSnapshot | null;
  new: FactSnapshot | null;
  at: Date;
};

export const maxFactTopicLength = 100;
const factFields = {
  type: z.enum(factTypes),
  topic: storable(z.string().trim().min(1).max(maxFactTopicLength)),
  value: storable(z.string()),
  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),
};
/** A value must fit its type, and a fact can't end before it starts. */
function refineFact(
  {
    type,
    value,
    validFrom,
    validUntil,
  }: Pick<FactSnapshot, "type" | "value"> & Partial<Pick<FactSnapshot, "validFrom" | "validUntil">>,
  context: z.RefinementCtx,
) {
  if (checkFactValue(type, value) === null) {
    context.addIssue({ code: "custom", path: ["value"], message: `Not a valid ${type} value` });
  }
  if (validFrom && validUntil && validUntil <= validFrom) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "Ends before it starts" });
  }
}
const factAddFields = {
  /** What a reply names it by: lower case, with dots, dashes and underscores. */
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  ...factFields,
};
export const factAddInput = z.object(factAddFields).superRefine(refineFact);
/** A fact's key is fixed once it's made, since a reply may already name it. */
/** An edit replaces the fact's fields, so the valid dates are given too, or null to clear them. */
export const factEditInput = z
  .object({
    id: z.uuid(),
    ...factFields,
    validFrom: z.date().nullable(),
    validUntil: z.date().nullable(),
  })
  .superRefine(refineFact);

/** The most characters of a question a reply carries into a Gap. */
export const maxGapQuestionLength = 500;

/** One question the Representatives couldn't confirm: the Model's wording, so plain text for the owner only. */
export type GapView = {
  id: string;
  question: string;
  /** How many times it came up, in any wording that normalizes to the same text. */
  count: number;
  /** The Representative that first logged it; null once that one is deleted. */
  representativeId: string | null;
  firstAt: Date;
  lastAt: Date;
};

/** Turns a Gap into a fact: the fact's fields, and the Gap it answers. */
export const gapToFactInput = z.object({ id: z.uuid(), ...factAddFields }).superRefine(refineFact);

export const idInput = z.object({ id: z.uuid() });
export const approveInput = z.object({
  id: z.uuid(),
  /** Approve anyway: why, when the tests failed or haven't finished. Logged with the Release. */
  overrideReason: storable(z.string().max(maxOverrideReasonLength)).optional(),
});
export const rollbackInput = z.object({ id: z.uuid(), releaseId: z.uuid() });
export const createInput = z.object({
  name: storable(z.string().trim().min(1).max(100)),
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
  /** The owner's no to a Bot's draft: the Bot is told, and the draft stays. */
  declineApproval: oc.input(idInput).output(type<RepresentativeView>()),
  /** What the draft changes against the live Release, so the owner reviews only that. */
  diff: oc.input(idInput).output(type<DraftDiff>()),
  /** Repoints the live Release to an earlier one of this Representative, with no test and no new Release. */
  rollback: oc.input(rollbackInput).output(type<RepresentativeView>()),
  /** Switches the Representative on or off, with no new Release. */
  setEnabled: oc.input(setEnabledInput).output(type<RepresentativeView>()),
  /** Chooses which of the owner's Bots it reports to; its open Assignments move to that Bot. */
  setBot: oc.input(setBotInput).output(type<RepresentativeView>()),
  /** The owner's Customers, oldest first. */
  customerList: oc.output(type<CustomerView[]>()),
  /** Adds a Customer by hand, with its first identity. Refused when the owner already has that identity. */
  customerCreate: oc.input(customerCreateInput).output(type<CustomerView>()),
  /** Names a Customer, or clears the name with an empty one. */
  customerRename: oc.input(customerRenameInput).output(type<CustomerView>()),
  /** Gives a Customer another identity. Refused when the owner already has it, on this Customer or another. */
  customerAddIdentity: oc.input(customerAddIdentityInput).output(type<CustomerView>()),
  /** Corrects one identity. Refused when it would match another of the owner's identities. */
  customerUpdateIdentity: oc.input(customerUpdateIdentityInput).output(type<CustomerView>()),
  /** Blocks or unblocks a Customer: a blocked one's message is kept for the owner and answered by no one. */
  customerSetBlocked: oc.input(customerSetBlockedInput).output(type<CustomerView>()),
  /**
   * Merges Customer `id` into `intoId`, whose thread goes on where both have one open with a
   * Representative. Refused while either is blocked. It verifies nobody, and can be undone.
   */
  customerMerge: oc.input(customerMergeInput).output(type<CustomerView>()),
  /** The owner's merges of Customers, newest first, undone ones too. */
  customerMergeList: oc.output(type<CustomerMergeView[]>()),
  /** Undoes a merge: each identity goes back to its original Customer, and a closed thread stays closed. */
  customerMergeUndo: oc.input(idInput).output(type<CustomerMergeView>()),
  /** The owner's Published facts, grouped by topic and then key. They are shared by every Representative. */
  factList: oc.output(type<FactView[]>()),
  /** Adds a fact, which applies at once. Refused when a value doesn't fit its type or the owner already has the key. */
  factAdd: oc.input(factAddInput).output(type<FactView>()),
  /** Changes a fact's type, topic, value or valid dates, which applies at once. The key stays. */
  factEdit: oc.input(factEditInput).output(type<FactView>()),
  /** Deletes a fact. */
  factDelete: oc.input(idInput).output(type<FactLogView>()),
  /** Every add, edit and delete of the owner's facts, newest first. */
  factLog: oc.output(type<FactLogView[]>()),
  /** The owner's open Gaps, the most recently asked first. */
  gapList: oc.output(type<GapView[]>()),
  /** Dismisses a Gap: it leaves the list, and the same question asked again starts a new one. */
  gapDismiss: oc.input(idInput).output(type<GapView>()),
  /** Adds a fact and closes the Gap it answers, together. Refused when the owner has the key already. */
  gapToFact: oc.input(gapToFactInput).output(type<FactView>()),
  /** A Representative's Customer threads, the most recently active first. */
  threadList: oc.input(idInput).output(type<ThreadSummary[]>()),
  /** One thread with its transcript, holder and who it waits on. */
  threadGet: oc.input(idInput).output(type<ThreadView>()),
  /** Takes a thread over: its running Turn is aborted, and the Customer gets one fixed note. No model call runs until the owner hands back. */
  threadTakeOver: oc.input(idInput).output(type<ThreadView>()),
  /** Hands a held thread back to the Representative, which answers what the owner left unanswered. */
  threadHandBack: oc.input(idInput).output(type<ThreadView>()),
  /** The owner's own message to the Customer, on a thread they hold. */
  threadSend: oc.input(threadSendInput).output(type<ThreadView>()),
};

export type RepresentativeContract = typeof representativeContract;
