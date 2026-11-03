import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
import type {
  Draft,
  PendingApproval,
  ReleaseContent,
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
 * that sender; all four are null for a test conversation. `threadId` is cleared if the thread goes.
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
  },
  (table) => [
    index("representative_hand_off_representative_idx").on(table.representativeId),
    index("representative_hand_off_thread_idx").on(table.threadId),
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
    /** What the owner calls them; null until they say. */
    name: text("name"),
    /** When the owner blocked them; null while not blocked. A blocked Customer's message runs no Turn. */
    blockedAt: timestamp("blocked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("representative_customer_user_idx").on(table.userId, table.createdAt)],
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

/** Who holds a Customer thread, or `closed` once it has ended. */
export type ThreadState = "representative" | "owner" | "closed";

/**
 * A Customer thread: the one running exchange between a Customer and a Representative, across the
 * Customer's Channels. It is never a Conversation. `lastChannel` and `lastExternalId` are where the
 * Customer was last heard from by a verified sender, or first heard from if none has been, which is
 * where anything sent outside a Turn goes: an unverified sender can't move it to themselves. `messageCount` numbers its messages.
 * `turnId` is the Turn that holds it, queued or running, and also its job's key. `waitingFrom` is the
 * position of the oldest message waiting for a Turn, and `waitingSince` when messages began to wait,
 * by the SDK's clock; both are null when none waits. While the owner holds the thread they mark what
 * a Turn answers after Hand back, unless the owner answers first.
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
    waitingFrom: integer("waiting_from"),
    waitingSince: timestamp("waiting_since"),
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
 * Who wrote a thread message; a `note` is the fixed line the Customer gets when the owner takes
 * over, and a `bot` message is what the Bot finished a hand-off with, for the Customer (ticket #1254).
 */
export type ThreadAuthor = "customer" | "representative" | "owner" | "note" | "bot";

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [unique("representative_thread_message_position").on(table.threadId, table.position)],
);
