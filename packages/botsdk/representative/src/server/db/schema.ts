import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bot, botAssignment, botsdkSchema } from "@botsdk/bot/storage";
import { defaultSpendingCaps } from "../../shared/contract";
import type { ChannelProofRule } from "../verification";
import type { ReplySource, StoredReplyKind } from "../../shared/replies";
import type {
  CustomerSummarySkip,
  Draft,
  FactType,
  FixedProfileField,
  OptOutSource,
  PendingApproval,
  ProfileSource,
  ProfileStatus,
  ReleaseContent,
  SpendingCaps,
  TestCheck,
  TestResultStatus,
  TranscriptEntry,
} from "../../shared/contract";

/**
 * A Representative (spec #1167): an agent that speaks for one user's business. It holds the
 * owner's working draft and points at its live Release; on/off is its own, outside every Release.
 */
export const representative = botsdkSchema.table(
  "representative",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** The Bot it reports to; null reports to the owner, which is where a deleted Bot's row leaves it. */
    botId: uuid("bot_id").references((): AnyPgColumn => bot.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /**
     * The Outbound gate's caps on what it sends a Customer (ticket #1304), the owner's to edit and in no
     * Release: messages in a row with no Customer reply, and messages in a rolling day.
     */
    maxInARow: integer("max_in_a_row").notNull().default(5),
    maxPerDay: integer("max_per_day").notNull().default(20),
    /**
     * What the Representative may cost (ticket #1310): model calls and money per thread, per Customer
     * per day, per unverified Customer per day, and money per month. The owner's to edit, in no Release.
     */
    spendingCaps: jsonb("spending_caps")
      .$type<SpendingCaps>()
      .notNull()
      .default(defaultSpendingCaps),
    /**
     * How long an Assignment it hands to a Bot may run before it is overdue (ticket #1312), in minutes.
     * The owner's to edit, in no Release.
     */
    assignmentDueMinutes: integer("assignment_due_minutes").notNull().default(30),
    /**
     * Quiet hours (ticket #1303), the owner's to edit and in no Release: the Outbound gate holds what the
     * business starts from `quietStartHour` to `quietEndHour` (0 to 23, wrapping past midnight) in the
     * Customer's time zone, or else in `businessTimeZone`, an IANA name.
     */
    quietStartHour: integer("quiet_start_hour").notNull().default(21),
    quietEndHour: integer("quiet_end_hour").notNull().default(8),
    businessTimeZone: text("business_time_zone").notNull().default("UTC"),
    /** The Release new Turns use. No foreign key: the two tables point at each other. Null until the first approval. */
    liveReleaseId: uuid("live_release_id"),
    draft: jsonb("draft").$type<Draft>().notNull(),
    /** The card of the Approval a Bot's draft is waiting on (ticket #1195); null when none was asked. */
    pendingApproval: jsonb("pending_approval").$type<PendingApproval>(),
    /** The hash of the draft a Bot last wrote: anything else in `draft` is the owner's own edit. */
    botDraftHash: text("bot_draft_hash"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("representative_user_idx").on(table.userId, table.createdAt)],
);

/**
 * The text of a document chosen for a draft (ticket #1259). A row never changes: a new upload is a new
 * row, and one goes only once neither the draft nor a Release refers to it. It goes with its
 * Representative, which takes it out of the owner's account delete.
 */
export const representativeDocument = botsdkSchema.table(
  "representative_document",
  {
    id: uuid("id").primaryKey(),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    text: text("text").notNull(),
    /** SHA-256 of the text. */
    hash: text("hash").notNull(),
    chars: integer("chars").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("representative_document_representative_idx").on(table.representativeId)],
);

/**
 * A Release: one unchangeable version of a Representative, numbered from 1. Nothing updates a row
 * once it is inserted; rollback only repoints `representative.live_release_id`.
 */
export const representativeRelease = botsdkSchema.table(
  "representative_release",
  {
    id: uuid("id").primaryKey(),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    /** What the Release pins: job text, switches, Skills, tools, Model, document snapshot and tests. */
    content: jsonb("content").$type<ReleaseContent>().notNull(),
    approvedAt: timestamp("approved_at").defaultNow().notNull(),
    /** Why the owner approved with tests failed or unfinished (ticket #1192); null when they allowed it. */
    overrideReason: text("override_reason"),
  },
  (table) => [unique("representative_release_number").on(table.representativeId, table.number)],
);

/**
 * The result of one of a draft's test conversations (ticket #1192). `draftHash` says which draft it
 * ran on, so it counts only while the draft is still that one. A new run deletes the rows before it.
 */
export const representativeTestResult = botsdkSchema.table(
  "representative_test_result",
  {
    id: uuid("id").primaryKey(),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    draftHash: text("draft_hash").notNull(),
    /** The conversation's place in the draft's `tests`. */
    position: integer("position").notNull(),
    status: text("status").$type<TestResultStatus>().notNull(),
    transcript: jsonb("transcript").$type<TranscriptEntry[]>().notNull(),
    checks: jsonb("checks").$type<TestCheck[]>().notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("representative_test_result_position").on(table.representativeId, table.position),
  ],
);

/**
 * An Assignment a Representative handed to its Bot (`hand_to_bot`), so that choosing another Bot
 * can move the open ones. It goes with the Assignment, and with the Representative. From a Customer
 * thread (ticket #1254), `threadId` is the thread it belongs to, and `channel`, `externalId` and
 * `verified` are the sender and standing of the Turn that handed it off, so its result goes back to
 * that sender; all four are null for a test conversation. `threadId` is cleared if the thread goes (it
 * expires, ticket #1285). `customerId` is the thread's Customer when the hand-off is made and holds
 * no text; the row goes with that Customer, so the Customer's delete still finds the Assignment.
 */
export const representativeHandOff = botsdkSchema.table(
  "representative_hand_off",
  {
    assignmentId: uuid("assignment_id")
      .primaryKey()
      .references((): AnyPgColumn => botAssignment.id, { onDelete: "cascade" }),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references((): AnyPgColumn => representativeThread.id, {
      onDelete: "set null",
    }),
    channel: text("channel"),
    externalId: text("external_id"),
    verified: boolean("verified"),
    customerId: uuid("customer_id").references((): AnyPgColumn => representativeCustomer.id, {
      onDelete: "cascade",
    }),
  },
  (table) => [
    index("representative_hand_off_representative_idx").on(table.representativeId),
    index("representative_hand_off_thread_idx").on(table.threadId),
    index("representative_hand_off_customer_idx").on(table.customerId),
  ],
);

/**
 * A Customer (spec #1168): a person who deals with one owner's business. Its Representatives share
 * it. It isn't a user, and it is made by its first message, with no sign-up.
 */
export const representativeCustomer = botsdkSchema.table(
  "representative_customer",
  {
    id: uuid("id").primaryKey(),
    /** The owner: the Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** When the owner blocked them; null while not blocked. A blocked Customer's message runs no Turn. */
    blockedAt: timestamp("blocked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("representative_customer_user_idx").on(table.userId, table.createdAt)],
);

/** A field an owner defines for all their Customers' profiles, beside the fixed ones. */
export const representativeProfileField = botsdkSchema.table(
  "representative_profile_field",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("representative_profile_field_name").on(table.userId, sql`lower(${table.name})`),
  ],
);

/**
 * One value of a Customer's profile: of a fixed field or of one the owner defined, never both. It
 * says where it came from, whether it is `confirmed` or only `claimed`, and when it was recorded.
 */
export const representativeProfileValue = botsdkSchema.table(
  "representative_profile_value",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => representativeCustomer.id, { onDelete: "cascade" }),
    fixedField: text("fixed_field").$type<FixedProfileField>(),
    fieldId: uuid("field_id").references(() => representativeProfileField.id, {
      onDelete: "cascade",
    }),
    value: text("value").notNull(),
    source: text("source").$type<ProfileSource>().notNull(),
    status: text("status").$type<ProfileStatus>().notNull(),
    /** From the SDK's clock, like a Published fact's times. */
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (table) => [
    unique("representative_profile_value_fixed").on(table.customerId, table.fixedField),
    unique("representative_profile_value_field").on(table.customerId, table.fieldId),
    index("representative_profile_value_field_idx").on(table.fieldId),
    check(
      "representative_profile_value_one_field",
      sql`num_nonnulls(${table.fixedField}, ${table.fieldId}) = 1`,
    ),
  ],
);

/**
 * One way of reaching a Customer: a Channel and that Channel's id for them, unique per owner. A new
 * identity makes a new Customer, so the same number on two Channels is two Customers.
 */
export const representativeCustomerIdentity = botsdkSchema.table(
  "representative_customer_identity",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => representativeCustomer.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    /** Its last verified contact; null when never verified, or lapsed. Verification is per identity. */
    verifiedContactAt: timestamp("verified_contact_at"),
    /** When its verification lapsed; null when it hasn't, or it has been verified since. */
    lapsedAt: timestamp("lapsed_at"),
    /** Until when a passed code or signed link vouches for its messages; null when none has. */
    provenUntil: timestamp("proven_until"),
    /** When they opted out of hearing from the business (ticket #1302); null when they haven't, or have come back. */
    optedOutAt: timestamp("opted_out_at"),
    /** How they opted out: a Channel's keyword, or a Representative's flag; null with `optedOutAt`. */
    optOutSource: text("opt_out_source").$type<OptOutSource>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("representative_customer_identity_address").on(
      table.userId,
      table.channel,
      table.externalId,
    ),
    index("representative_customer_identity_customer_idx").on(table.customerId),
  ],
);

/** Who merged two Customers: a code the sender passed, or the owner by hand. */
export type CustomerMergeHow = "code" | "owner";

/**
 * A hold of the owner's on an absorbed thread that a merge closed, passing to the surviving thread:
 * `caused` when the owner held the surviving one only because of this.
 */
export type MovedHold = {
  closedThreadId: string;
  survivingThreadId: string;
  caused: boolean;
  /** What the closed thread had waiting, which undoing gives back to it. */
  waitingFrom: number | null;
};

/**
 * One merge of a Customer into another (ticket #1257), kept once undone. The absorbed Customer's row
 * stays, with no identities or threads, so that undoing gives each back to it: `identityIds` and
 * `threadIds` are what moved, and `movedHolds` the holds it moved that haven't been handed back since.
 * A Customer with a merge not undone is gone from everything but this.
 */
export const representativeCustomerMerge = botsdkSchema.table(
  "representative_customer_merge",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    survivorCustomerId: uuid("survivor_customer_id")
      .notNull()
      .references((): AnyPgColumn => representativeCustomer.id, { onDelete: "cascade" }),
    absorbedCustomerId: uuid("absorbed_customer_id")
      .notNull()
      .references((): AnyPgColumn => representativeCustomer.id, { onDelete: "cascade" }),
    how: text("how").$type<CustomerMergeHow>().notNull(),
    identityIds: jsonb("identity_ids").$type<string[]>().notNull(),
    threadIds: jsonb("thread_ids").$type<string[]>().notNull(),
    /** The hand-offs that go back with it, by Assignment, as a hand-off outlives its thread. */
    handOffIds: jsonb("hand_off_ids").$type<string[]>().notNull().default([]),
    movedHolds: jsonb("moved_holds").$type<MovedHold[]>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    undoneAt: timestamp("undone_at"),
  },
  (table) => [
    index("representative_customer_merge_user_idx").on(table.userId, table.createdAt),
    index("representative_customer_merge_survivor_idx").on(table.survivorCustomerId),
    uniqueIndex("representative_customer_merge_absorbed_idx")
      .on(table.absorbedCustomerId)
      .where(sql`${table.undoneAt} is null`),
  ],
);

/** How a verification reaches its target: a code to send back, or a signed link to open. */
export type VerificationKind = "code" | "link";

/**
 * One code or signed link sent so that a sender can prove who they are (ticket #1256). `sender` is
 * the identity it proves and the only one that may pass it; `target` is the identity it went to,
 * which is the sender itself on a Channel whose rule is a round trip. Only a sender's newest counts.
 */
export const representativeVerification = botsdkSchema.table(
  "representative_verification",
  {
    id: uuid("id").primaryKey(),
    senderIdentityId: uuid("sender_identity_id")
      .notNull()
      .references((): AnyPgColumn => representativeCustomerIdentity.id, { onDelete: "cascade" }),
    targetIdentityId: uuid("target_identity_id")
      .notNull()
      .references((): AnyPgColumn => representativeCustomerIdentity.id, { onDelete: "cascade" }),
    kind: text("kind").$type<VerificationKind>().notNull(),
    /** A keyed hash of a code; null for a link, whose signature is stored nowhere. */
    codeHash: text("code_hash"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    /** From the runner's clock, since expiry and the send limit are counted on it. */
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("representative_verification_sender_idx").on(table.senderIdentityId, table.createdAt),
    index("representative_verification_target_idx").on(table.targetIdentityId, table.createdAt),
  ],
);

/** Who holds a Customer thread, or `closed` once it has ended. */
export type ThreadState = "representative" | "owner" | "closed";

/**
 * A Customer thread: the one running exchange between a Customer and a Representative, across the
 * Customer's Channels. It is never a Conversation. `lastChannel` and `lastExternalId` are where the
 * Customer was last heard from by a verified sender, or first heard from if none has been, which is
 * where anything sent outside a Turn goes: an unverified sender can't move it to themselves. `messageCount` numbers its messages.
 * `turnFrom` is where the batch of the Turn holding it starts, once that Turn has begun and until it
 * first replies: what a takeover aborting it leaves unanswered.
 * `turnId` is the Turn that holds it, queued or running, and also its job's key. `waitingFrom` is the
 * position of the oldest message waiting for a Turn, and `waitingSince` when messages began to wait,
 * by the SDK's clock; both are null when none waits. While the owner holds the thread they mark what
 * a Turn answers after Hand back, unless the owner answers first. `limitNotedAt` is set while the
 * thread is at a limit, and says its note has gone (ticket #1309); `leftForOwnerAt` when the owner is
 * owed an answer no Turn will give, as what waited through a limit grew too old, until they send one.
 */
export const representativeThread = botsdkSchema.table(
  "representative_thread",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => representativeCustomer.id, { onDelete: "cascade" }),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    state: text("state").$type<ThreadState>().notNull().default("representative"),
    lastChannel: text("last_channel").notNull(),
    lastExternalId: text("last_external_id").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    turnId: uuid("turn_id"),
    turnFrom: integer("turn_from"),
    waitingFrom: integer("waiting_from"),
    waitingSince: timestamp("waiting_since"),
    limitNotedAt: timestamp("limit_noted_at"),
    leftForOwnerAt: timestamp("left_for_owner_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("representative_thread_open_idx")
      .on(table.customerId, table.representativeId)
      .where(sql`${table.state} <> 'closed'`),
    index("representative_thread_customer_idx").on(table.customerId),
    index("representative_thread_representative_idx").on(table.representativeId),
  ],
);

/**
 * A Representative Turn, kept for what it costs (ticket #1310): `id` is the Turn's id, which its usage
 * rows hold as their source id. It finds its Customer through its thread, so it follows a merge, and
 * goes with its thread or Representative.
 */
export const representativeTurn = botsdkSchema.table(
  "representative_turn",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references((): AnyPgColumn => representativeThread.id, { onDelete: "cascade" }),
    representativeId: uuid("representative_id")
      .notNull()
      .references((): AnyPgColumn => representative.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("representative_turn_thread_idx").on(table.threadId),
    index("representative_turn_representative_idx").on(table.representativeId),
  ],
);

/**
 * Who wrote a thread message; a `note` is the fixed line the Customer gets when the owner takes
 * over, and a `bot` message is what the Bot finished a hand-off with, for the Customer (ticket #1254).
 */
export type ThreadAuthor = "customer" | "representative" | "owner" | "note" | "bot";

/**
 * What the pass wrote when a Customer thread closed (ticket #1279): one row per thread, its summary
 * or why there is none. It finds its Customer through its thread, so it follows a merge.
 */
export const representativeCustomerSummary = botsdkSchema.table(
  "representative_customer_summary",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .unique("representative_customer_summary_thread")
      .references((): AnyPgColumn => representativeThread.id, { onDelete: "cascade" }),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** Null when the pass was skipped. */
    text: text("text"),
    /** Why the pass wrote nothing; null on a summary. */
    skipped: text("skipped").$type<CustomerSummarySkip>(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("representative_customer_summary_user_idx").on(table.userId)],
);

/**
 * One message in a Customer thread: the feature's own row, not a core Message. `channel` and
 * `externalId` are where it was heard from, or where a reply went. `position` is its place in the
 * thread, taken under the thread's row lock, so it is the order the messages were really stored in.
 * `verified` says its Turn's sender was verified, or for what the owner sent, that its address has
 * been; a Turn for an unverified sender never reads it.
 * It defaults to true so that a row nobody vouched for stays out of those Turns.
 */
export const representativeThreadMessage = botsdkSchema.table(
  "representative_thread_message",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references((): AnyPgColumn => representativeThread.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    author: text("author").$type<ThreadAuthor>().notNull(),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    text: text("text").notNull(),
    verified: boolean("verified").notNull().default(true),
    /** The rule its Channel checks its sender by, which decides how a Turn can have them proved. */
    proofRule: text("proof_rule").$type<ChannelProofRule>(),
    /** A Bot's result that came while the owner held the thread: theirs to send, never a Turn's. */
    heldForOwner: boolean("held_for_owner").notNull().default(false),
    /** A reply's kind (ticket #1260); null on every other message and on a reply stored before kinds. */
    replyKind: text("reply_kind").$type<StoredReplyKind>(),
    /** What a reply rests on, as code checked it, kept from the Customer; null as for `replyKind`. */
    sources: jsonb("sources").$type<ReplySource[]>(),
    /** The Assignment a Bot's result ended, which a reply relaying it cites. No foreign key: the result outlives it. */
    assignmentId: uuid("assignment_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [unique("representative_thread_message_position").on(table.threadId, table.position)],
);

/**
 * A Published fact (ticket #1258): one typed piece of the owner's business information, shared by
 * every one of their Representatives and outside every Release, so an edit applies at once. `value`
 * is in the stored form its type gives it. A key is unique per owner.
 */
export const representativeFact = botsdkSchema.table(
  "representative_fact",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    type: text("type").$type<FactType>().notNull(),
    topic: text("topic").notNull(),
    value: text("value").notNull(),
    /** From when it is in effect; null for always. */
    validFrom: timestamp("valid_from"),
    /** Until when, not including it; null for never. */
    validUntil: timestamp("valid_until"),
    /** From the SDK's clock, since which facts are in effect is counted on it. */
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [unique("representative_fact_key").on(table.userId, table.key)],
);

/** A fact as a log keeps it: JSON, so its dates are ISO strings. */
export type LoggedFact = {
  type: FactType;
  topic: string;
  value: string;
  validFrom: string | null;
  validUntil: string | null;
};

/** What a change did to a fact. */
export type FactAction = "add" | "edit" | "delete";

/**
 * One add, edit or delete of a Published fact (ticket #1258). It holds the key and both sides of
 * the change, with no foreign key, so it outlives the fact it records.
 */
export const representativeFactLog = botsdkSchema.table(
  "representative_fact_log",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    action: text("action").$type<FactAction>().notNull(),
    old: jsonb("old").$type<LoggedFact>(),
    new: jsonb("new").$type<LoggedFact>(),
    /** The Bot, by its name then, whose proposal the owner approved; null for the owner's own change. */
    proposedBy: text("proposed_by"),
    at: timestamp("at").notNull(),
  },
  (table) => [index("representative_fact_log_user_idx").on(table.userId, table.at)],
);

/** Where a Gap stands: `open` until the owner dismisses it or turns it into a fact. */
export type GapStatus = "open" | "dismissed" | "answered";

/**
 * A Gap (ticket #1263): a question a Representative couldn't confirm from any source, which the
 * owner can answer with a fact or dismiss. It belongs to the owner, and `representativeId` is the
 * Representative that first logged it, cleared if that one is deleted. `question` is the Model's
 * own wording, so it is untrusted and only ever shown to the owner as plain text. `normalized` is
 * what the owner's open Gaps are deduplicated by, with `count` of how often it came up. A dismissed
 * or answered one is never counted again: the same question then starts a new Gap.
 */
export const representativeGap = botsdkSchema.table(
  "representative_gap",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    representativeId: uuid("representative_id").references((): AnyPgColumn => representative.id, {
      onDelete: "set null",
    }),
    question: text("question").notNull(),
    normalized: text("normalized").notNull(),
    count: integer("count").notNull().default(1),
    status: text("status").$type<GapStatus>().notNull().default("open"),
    /** From the SDK's clock, like the facts' dates. */
    firstAt: timestamp("first_at").notNull(),
    lastAt: timestamp("last_at").notNull(),
    closedAt: timestamp("closed_at"),
  },
  (table) => [
    uniqueIndex("representative_gap_open_idx")
      .on(table.userId, table.normalized)
      .where(sql`${table.status} = 'open'`),
    index("representative_gap_user_idx").on(table.userId, table.lastAt),
  ],
);

/**
 * A Bot's proposed Published fact, waiting for the owner (ticket #1264): the whole fact it would
 * become. It goes when answered, dropped or replaced, and one that expired stays only until the
 * owner's next proposal clears it, changing nothing meanwhile. One waits per key. It goes with its
 * Bot, whose card goes with the Conversation. A lesson from the Customer memory pass (ticket #1289)
 * has no Bot and no card, and no link to the Customer or thread it came from.
 */
export const representativeFactProposal = botsdkSchema.table(
  "representative_fact_proposal",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Null for a lesson. */
    botId: uuid("bot_id").references((): AnyPgColumn => bot.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    proposed: jsonb("proposed").$type<LoggedFact>().notNull(),
    why: text("why").notNull(),
    /** The Approval's card in the Bot's Conversation; null for a lesson. */
    cardId: text("card_id"),
    /** The Turn and tool call that asked, so a replay after a crash asks only once. */
    call: text("call"),
    postedAt: timestamp("posted_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    unique("representative_fact_proposal_key").on(table.userId, table.key),
    index("representative_fact_proposal_bot_idx").on(table.botId),
  ],
);

/**
 * Which message passed the Outbound gate, which says what rules it passes. `released` is a held message
 * the owner sent (ticket #1304): the Representative's own, so it counts against the day's cap.
 */
export type OutboundKind =
  | "reply"
  | "code_hand_off"
  | "limit_note"
  | "stall_note"
  | "owner"
  | "released"
  | "takeover_note"
  | "proof"
  | "opt_out_confirmation"
  | "holding_note"
  | "reply_draft"
  | "emergency_script"
  | "emergency_script_released";

export type GateOutcome = "send" | "hold" | "drop";

/**
 * One Outbound gate decision (ticket #1298): what was going where, what became of it, the rule that
 * decided and the Release in effect. It holds no words: those are in the thread message it sent or
 * the held message it kept. It goes with its thread, so a Customer's delete and a thread's expiry
 * take it. A later rule, a real deployment's too, needs only its own name in `rule`.
 */
export const representativeOutboundDecision = botsdkSchema.table(
  "representative_outbound_decision",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references((): AnyPgColumn => representativeThread.id, { onDelete: "cascade" }),
    kind: text("kind").$type<OutboundKind>().notNull(),
    outcome: text("outcome").$type<GateOutcome>().notNull(),
    /** The gate rule that decided, or `passed` when none stopped it. */
    rule: text("rule").notNull(),
    /** The Release of the Turn behind it, or else the live one. No foreign key: the log outlives a Release's row. */
    releaseId: uuid("release_id"),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    /** The thread message it sent; null for anything held or dropped, and for a proof, which is never stored. */
    messageId: uuid("message_id").references((): AnyPgColumn => representativeThreadMessage.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("representative_outbound_decision_thread_idx").on(table.threadId, table.id),
    index("representative_outbound_decision_message_idx").on(table.messageId),
  ],
);

/** The gate rule that holds a Reply draft, which the owner answers apart from any other held message. */
export const draftRule = "topic";

/**
 * What became of a held message: the owner approved it, sent it with their edit or rejected it, a
 * newer word on the thread replaced it, or the Turn that wrote it was rolled back. Null while it waits.
 */
export type HeldResolution = "approved" | "edited" | "rejected" | "replaced" | "cancelled";

/**
 * A message the gate held: stored, not sent, and not in the thread until something sends it (ticket
 * #1298). One held by the `topic` rule is a Reply draft (ticket #1306).
 */
export const representativeHeldMessage = botsdkSchema.table(
  "representative_held_message",
  {
    id: uuid("id").primaryKey(),
    decisionId: uuid("decision_id")
      .notNull()
      .references((): AnyPgColumn => representativeOutboundDecision.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references((): AnyPgColumn => representativeThread.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    verified: boolean("verified").notNull(),
    replyKind: text("reply_kind").$type<StoredReplyKind>(),
    sources: jsonb("sources").$type<ReplySource[]>(),
    /** The topic its reply was labelled with, as the Model wrote it; null with no label. */
    topic: text("topic"),
    resolution: text("resolution").$type<HeldResolution>(),
    resolvedAt: timestamp("resolved_at"),
    /** The thread message that sent it, which holds any edit; this row keeps what was first written. */
    messageId: uuid("message_id").references((): AnyPgColumn => representativeThreadMessage.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("representative_held_message_thread_idx").on(table.threadId),
    index("representative_held_message_decision_idx").on(table.decisionId),
  ],
);

/** Whether a reply on a topic waits for the owner or goes out by itself. */
export type TopicMode = "draft" | "auto";

/**
 * One of the owner's topics (ticket #1306), which a Representative labels each reply with. All start
 * at `draft`, and a name the owner doesn't have counts as one. Shared by all their Representatives.
 */
export const representativeTopic = botsdkSchema.table(
  "representative_topic",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    mode: text("mode").$type<TopicMode>().notNull().default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("representative_topic_name").on(table.userId, sql`lower(${table.name})`)],
);
