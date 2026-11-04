import { oc, type } from "@orpc/contract";
import { z } from "zod";

import { checkFactValue, factTypes, type FactType } from "./facts";
import type { ReplyProof } from "./replies";

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
export const representativeTools = [
  "reply",
  "hand_to_bot",
  "verify_customer",
  "read_customer_work",
] as const;
export type RepresentativeTool = (typeof representativeTools)[number];

export const maxJobTextLength = 20_000;
export const maxSkills = 50;
export const maxSkillTextLength = 20_000;
export const maxTestConversations = 20;
export const maxExpectations = 20;
export const maxOverrideReasonLength = 1_000;
export const maxSwitches = 100;
/** The most characters a Release's documents may hold together: past it, a draft can't be approved. */
export const maxReleaseDocumentChars = 100_000;
/** The most documents a draft may hold. */
export const maxDraftDocuments = 50;
/** The most readable text one document may hold, in bytes: what Knowledge allows a converted file. */
export const maxDocumentTextBytes = 2 * 1024 * 1024;
/** The longest a document's name may be. */
export const maxDocumentNameLength = 200;

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
 * `not_said` look for the text in what the Representative sent the Customer, ignoring case. `cited`
 * passes when a reply sent to the Customer carried a source code accepted, of the named fact or
 * document when one is named.
 */
export const expectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replied") }),
  z.object({ kind: z.literal("handed_off") }),
  z.object({ kind: z.literal("not_handed_off") }),
  z.object({ kind: z.literal("said"), text: storable(z.string().trim().min(1).max(500)) }),
  z.object({ kind: z.literal("not_said"), text: storable(z.string().trim().min(1).max(500)) }),
  z.object({
    kind: z.literal("cited"),
    source: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("fact"), key: storable(z.string().trim().min(1).max(64)) }),
        z.object({
          type: z.literal("document"),
          name: storable(z.string().trim().min(1).max(maxDocumentNameLength)),
        }),
      ])
      .optional(),
  }),
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

/**
 * A document in a draft or a Release: a reference to its text, which is kept in a row of its own that
 * never changes, because drafts and Releases pass through Checkpoints and tools that shouldn't hold it.
 */
export type DocumentRef = {
  id: string;
  name: string;
  /** SHA-256 of the text. */
  hash: string;
  /** How long the text is, in characters. */
  chars: number;
};

/** A draft: what the owner writes, and the documents they chose, which only the document procedures change. */
export type Draft = z.output<typeof draftSchema> & { documents: DocumentRef[] };

/** The characters `documents` hold together, which the Release cap counts. */
export const documentChars = (documents: DocumentRef[]) =>
  documents.reduce((total, document) => total + document.chars, 0);

/** A Knowledge file that can be picked for a draft. */
export type KnowledgeChoice = { path: string; size: number };

/** The documents a Release pinned, frozen and hashed at approval. */
export type DocumentSnapshot = {
  /** SHA-256 over each document's name and text hash, in order. */
  hash: string;
  documents: DocumentRef[];
};

/**
 * What a Release pins: the owner's draft, with its test conversations, and its document snapshot,
 * null when it has no documents.
 */
export type ReleaseContent = Omit<Draft, "documents"> & {
  documentSnapshot: DocumentSnapshot | null;
};

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
  /** What the Outbound gate holds a Customer to, in messages (ticket #1304). */
  caps: OutboundCaps;
  /** When the Outbound gate holds what the business starts (ticket #1303). */
  quietHours: QuietHours;
};

/** The most the Outbound gate lets a Representative send one Customer: in a row with no reply, and in a rolling day. */
export type OutboundCaps = { maxInARow: number; maxPerDay: number };

/**
 * The hours the Outbound gate holds what the business starts, from `startHour` to `endHour` (0 to 23,
 * wrapping past midnight) in the Customer's time zone, or in `timeZone`, the business's, when theirs is unknown.
 */
export type QuietHours = { startHour: number; endHour: number; timeZone: string };

/** One line of a test conversation's transcript. */
export type TranscriptEntry = {
  role: "customer" | "representative" | "tool" | "system";
  text: string;
  /** What a sent reply rests on; absent on every other line and on a result stored before it. */
  reply?: ReplyProof;
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
  /** The hash of the documents when the Bot asked; none for no documents. */
  documentsHash?: string;
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
  field: "jobText" | "switch" | "skill" | "tool" | "model" | "test" | "document";
  /**
   * The switch, Skill, tool, test or document the change is about; null for the job text and Model,
   * and for Skills, tests or documents put in another order, whose sides are then their names in
   * order.
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

/** The profile fields every Customer has: the name, which has its own path, and these. */
export const correctableFixedFields = [
  "language",
  "preferred_channel",
  "address",
  "time_zone",
] as const;
export const fixedProfileFields = ["name", ...correctableFixedFields] as const;
export type FixedProfileField = (typeof fixedProfileFields)[number];
/** Who a profile value came from: the owner who set it, or the author of the thread line the pass read it from. */
export type ProfileSource = "owner" | "customer" | "representative";
/** `confirmed` only if the owner set it or a verified Customer said it; `claimed` otherwise. */
export type ProfileStatus = "claimed" | "confirmed";

/** A field an owner defined for their Customers' profiles. */
export type ProfileFieldView = { id: string; name: string };

/** One value of a Customer's profile. */
export type ProfileValueView = {
  /** A fixed field, or the id of one the owner defined. */
  field: string;
  value: string;
  source: ProfileSource;
  status: ProfileStatus;
  recordedAt: Date;
};

/** One of the owner's Customers, shared by all their Representatives. */
export type CustomerView = {
  id: string;
  /** Their profile's name value; null until there is one. */
  name: string | null;
  profile: ProfileValueView[];
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

/** Why a closed thread has no summary: its Release names no Model, the Model can't run, it replied with nothing, or every try failed. */
export type CustomerSummarySkip = "no_model" | "model_unavailable" | "empty_reply" | "model_failed";

/** What the pass wrote for one of a Customer's closed threads. */
export type CustomerSummaryView = {
  id: string;
  /** The thread it came from, whose transcript `threadGet` reads. */
  threadId: string;
  representative: { id: string; name: string };
  /** Null when the pass was skipped. */
  text: string | null;
  skipped: CustomerSummarySkip | null;
  createdAt: Date;
};

/** Who holds a Customer thread: its Representative, the owner who took it over, or no one once closed. */
export type ThreadHolder = "representative" | "owner" | "closed";

/**
 * Who a thread is waiting on, derived from who holds it and who spoke last: the Customer after an
 * answer, and after a Customer's message the Representative, or the owner while they hold it. The
 * Bot, in place of the Customer, while an Assignment handed off from the thread is open. The owner
 * after code's fixed hand-off message with no Bot working on it (ticket #1261). Null
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
  /** A Representative's reply's kind and sources; null on every other message. */
  reply: ReplyProof | null;
  createdAt: Date;
};

/** A message the Outbound gate held (ticket #1304), which the owner sends or drops. Not in the transcript. */
export type HeldMessageView = {
  id: string;
  text: string;
  /** The rule that held it, such as `caps`. */
  rule: string;
  /** Where it would go. */
  channel: string;
  externalId: string;
  createdAt: Date;
};

export type ThreadView = ThreadSummary & {
  representativeId: string;
  /** The Customer's identities, each with whether it is verified. */
  identities: CustomerIdentityView[];
  /** Oldest first. */
  messages: ThreadMessageView[];
  /** What the gate has held on this thread, oldest first. */
  held: HeldMessageView[];
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

export const maxProfileFieldNameLength = 100;
export const maxProfileValueLength = 1_000;
const profileFieldName = storable(z.string().trim().min(1).max(maxProfileFieldNameLength));
export const profileFieldAddInput = z.object({ name: profileFieldName });
export const profileFieldRenameInput = z.object({ id: z.uuid(), name: profileFieldName });
export const customerProfileSetInput = z
  .object({
    id: z.uuid(),
    /** A fixed field other than the name, which `customerRename` sets, or an own field's id. */
    field: z.union([z.enum(correctableFixedFields), z.uuid()]),
    /** An empty value clears it. */
    value: storable(z.string().trim().max(maxProfileValueLength)),
  })
  .refine(({ field, value }) => field !== "time_zone" || value === "" || isTimeZone(value), {
    message: "Not a time zone",
    path: ["value"],
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
  /** The Bot, by its name then, whose proposal the owner approved; null for the owner's own change. */
  proposedBy: string | null;
  at: Date;
};

/** A Bot's proposed fact, or a lesson from the Customer memory pass, waiting for the owner, with what it would replace. */
export type FactProposalView = {
  id: string;
  key: string;
  /** The Bot that proposed it; null for a lesson. */
  botId: string | null;
  botName: string | null;
  why: string;
  /** The fact as it is now; null when the key has none. */
  current: FactSnapshot | null;
  proposed: FactSnapshot;
  postedAt: Date;
  expiresAt: Date;
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
/** What a reply names a fact by: lower case, with dots, dashes and underscores. */
export const factKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const factAddFields = { key: factKey, ...factFields };
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
export const documentUploadInput = z.object({ id: z.uuid(), file: z.file() });
export const documentPickInput = z.object({
  id: z.uuid(),
  path: storable(z.string().min(1).max(1_000)),
});
export const documentRemoveInput = z.object({ id: z.uuid(), documentId: z.uuid() });
export const maxOutboundCap = 1_000;
const capField = z.number().int().min(1).max(maxOutboundCap);
export const setCapsInput = z
  .object({ id: z.uuid(), maxInARow: capField.optional(), maxPerDay: capField.optional() })
  .refine(({ maxInARow, maxPerDay }) => maxInARow !== undefined || maxPerDay !== undefined, {
    message: "Give at least one cap",
  });
/** Whether `name` is an IANA time zone this runtime knows. */
export function isTimeZone(name: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
const hourField = z.number().int().min(0).max(23);
export const setQuietHoursInput = z.object({
  id: z.uuid(),
  startHour: hourField,
  endHour: hourField,
  timeZone: z.string().trim().max(100).refine(isTimeZone, "Not a time zone"),
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
  /**
   * Adds a document to the draft, its text copied now with no Computer; one of the same name is
   * replaced. Markdown and plain text always, PDF and DOCX when the Host passed a conversion.
   */
  documentUpload: oc.input(documentUploadInput).output(type<RepresentativeView>()),
  /** Whether Knowledge files can be picked for a draft: false on a Host with no Computer or Knowledge. */
  knowledgeStatus: oc.output(type<{ available: boolean }>()),
  /** The Knowledge files that can be picked, waking the owner's Computer. Refused when they can't be picked at all. */
  knowledgeList: oc.output(type<KnowledgeChoice[]>()),
  /**
   * Copies a Knowledge file's text into the draft as an upload would (a PDF or DOCX's converted copy),
   * named by its path; one of the same name is replaced. Later Knowledge edits reach the draft only by
   * picking the file again. The Computer is used for this and nothing else.
   */
  documentPick: oc.input(documentPickInput).output(type<RepresentativeView>()),
  /** Takes a document out of the draft. A Release that holds it keeps it. */
  documentRemove: oc.input(documentRemoveInput).output(type<RepresentativeView>()),
  /** Runs the draft's test conversations on a job, replacing earlier results, and returns at once. */
  runTests: oc.input(idInput).output(type<RepresentativeView>()),
  /**
   * Pins the draft as the next numbered Release and makes it live. Refused while its tests have
   * failed or haven't finished, unless `overrideReason` says why not, and whatever the reason while
   * its documents pass `maxReleaseDocumentChars`.
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
  /** Edits the caps on what the Outbound gate sends a Customer; a cap left out stays. No new Release. */
  setCaps: oc.input(setCapsInput).output(type<RepresentativeView>()),
  /** Edits the hours the gate holds what the business starts, and the business's time zone. No new Release. */
  setQuietHours: oc.input(setQuietHoursInput).output(type<RepresentativeView>()),
  /** Chooses which of the owner's Bots it reports to; its open Assignments move to that Bot. */
  setBot: oc.input(setBotInput).output(type<RepresentativeView>()),
  /** The owner's Customers, oldest first. */
  customerList: oc.output(type<CustomerView[]>()),
  /** Adds a Customer by hand, with its first identity. Refused when the owner already has that identity. */
  customerCreate: oc.input(customerCreateInput).output(type<CustomerView>()),
  /** Names a Customer, or clears the name with an empty one. */
  customerRename: oc.input(customerRenameInput).output(type<CustomerView>()),
  /** Sets or, with an empty value, clears a Customer's profile value, as `confirmed` by the owner, today. */
  customerProfileSet: oc.input(customerProfileSetInput).output(type<CustomerView>()),
  /** The owner's own profile fields, oldest first. */
  profileFieldList: oc.output(type<ProfileFieldView[]>()),
  /** Adds a profile field. Refused when its name is a fixed field's or another of the owner's, ignoring case. */
  profileFieldAdd: oc.input(profileFieldAddInput).output(type<ProfileFieldView>()),
  /** Renames a profile field, refused as adding one is. Its values stay. */
  profileFieldRename: oc.input(profileFieldRenameInput).output(type<ProfileFieldView>()),
  /** Removes a profile field and every Customer's value of it. */
  profileFieldRemove: oc.input(idInput),
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
  /**
   * Hard-deletes a Customer and everyone merged into them, with their identities, memory, threads and
   * hand-off contact details, and cancels their queued jobs. Messages to or from their identities on
   * other Customers' threads go too, with those threads' summaries, and a thread left empty. So do
   * undone merges holding their ids. Spend stays. It can't be undone.
   */
  customerDelete: oc.input(idInput),
  /** What the pass wrote for a Customer's closed threads, newest first, skips too. */
  customerSummaryList: oc.input(idInput).output(type<CustomerSummaryView[]>()),
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
  /** The facts the owner's Bots have proposed, and the lessons, that still wait for an answer, oldest first. */
  factProposals: oc.output(type<FactProposalView[]>()),
  /** Applies a Bot's proposed fact or a lesson, logged as its proposal, and wakes the Bot (a lesson wakes no one). */
  factProposalApprove: oc.input(idInput).output(type<FactView>()),
  /** Refuses a Bot's proposed fact or a lesson, which changes nothing, and wakes the Bot (a lesson wakes no one). */
  factProposalDecline: oc.input(idInput).output(type<void>()),
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
  /** Sends a message the gate held, as the owner's own, if the gate still passes it. Logged. */
  threadHeldSend: oc.input(idInput).output(type<ThreadView>()),
  /** Drops a message the gate held, which the Customer never gets. Logged. */
  threadHeldDrop: oc.input(idInput).output(type<ThreadView>()),
};

export type RepresentativeContract = typeof representativeContract;
