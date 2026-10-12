import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { MessageUsage } from "../../../shared/chat/message-record";
import type { ConversationTools } from "../../../shared/chat/conversation-tools";
import type { StoredParts } from "../../../shared/message-parts";
import { chatSchema } from "./chat-schema";

export type { MessageUsage };

/** How hard a reasoning Model thinks. Null means the Model's own default. */
export const reasoningEffort = chatSchema.enum("reasoning_effort", [
  "off",
  "low",
  "medium",
  "high",
]);

/** A Project: a named group of one user's Conversations, with Instructions and a default Model. */
export const project = chatSchema.table(
  "project",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id. Like a Conversation's, it has no foreign key to the user. */
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    /** The Project's Instructions; null when it has none. */
    instructions: text("instructions"),
    /** The default Model, `"provider:model"`; null when it has none. */
    defaultModel: text("default_model"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("project_user_id_idx").on(table.userId)],
);

/** A Conversation, owned by one user. Its Messages form a tree (ADR 0001). */
export const conversation = chatSchema.table(
  "conversation",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id. The SDK trusts `getUser` and keeps no foreign key to the user. */
    userId: text("user_id").notNull(),
    title: text("title"),
    /** The selected Model, `"provider:model"`; checked in code, not an enum. */
    model: text("model").notNull(),
    /** The effort the Conversation asks for; null means the Model's default. */
    reasoningEffort: reasoningEffort("reasoning_effort"),
    /** The newest Message of the Active Branch. */
    activeLeafId: uuid("active_leaf_id").references((): AnyPgColumn => message.id, {
      onDelete: "set null",
    }),
    /** The Project this Conversation is in; null when it is in none. Deleting it deletes this. */
    projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
    /** The MCP tools switched on here: its Connections and allowed tools (spec #91). */
    toolSettings: jsonb("tool_settings")
      .$type<ConversationTools>()
      .default(sql`'{"connections": [], "allowedTools": []}'::jsonb`)
      .notNull(),
    /** When the Conversation was pinned; null when it is not pinned. */
    pinnedAt: timestamp("pinned_at"),
    /** Bumped only by new Messages, never by renames or Branch switches. */
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("conversation_user_id_last_message_at_idx").on(table.userId, table.lastMessageAt.desc()),
    // The main list: a user's Conversations that are in no Project, newest first.
    index("conversation_unprojected_user_id_last_message_at_idx")
      .on(table.userId, table.lastMessageAt.desc())
      .where(sql`project_id is null`),
    // A Project's list, newest first.
    index("conversation_project_id_last_message_at_idx").on(
      table.projectId,
      table.lastMessageAt.desc(),
    ),
    // The Pinned section: a user's pinned Conversations, most recently pinned first.
    index("conversation_pinned_user_id_pinned_at_idx")
      .on(table.userId, table.pinnedAt.desc())
      .where(sql`pinned_at is not null`),
    index("conversation_title_trgm_idx").using("gin", table.title.op("public.gin_trgm_ops")),
  ],
);

export const messageRole = chatSchema.enum("message_role", ["user", "assistant"]);
export const messageStatus = chatSchema.enum("message_status", [
  "streaming",
  "complete",
  "stopped",
  "error",
  "awaiting_approval",
]);
export const messageErrorReason = chatSchema.enum("message_error_reason", [
  "invalid_key",
  "rate_limited",
  "provider_error",
]);

/** One Message of a Conversation. Several roots are allowed; there is no hidden root. */
export const message = chatSchema.table(
  "message",
  {
    /** uuidv7, generated in app code; client ids are ignored. */
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => message.id, {
      onDelete: "cascade",
    }),
    role: messageRole("role").notNull(),
    parts: jsonb("parts").$type<StoredParts>().notNull(),
    /** The Model that wrote an assistant Message; null for user Messages. */
    model: text("model"),
    status: messageStatus("status").notNull(),
    error: text("error"),
    errorReason: messageErrorReason("error_reason"),
    /** The effort an assistant Message ran with; null when the Model's default was used. */
    reasoningEffort: reasoningEffort("reasoning_effort"),
    /** Tokens the Run used, for display only; null on user Messages and on older Runs. */
    usage: jsonb("usage").$type<MessageUsage>(),
    /**
     * The first Message sent to the Model on this Run, when older Messages were dropped to fit the
     * window. Null means all of them were sent. Cleared, not cascaded, if that Message is deleted.
     */
    contextStartId: uuid("context_start_id").references((): AnyPgColumn => message.id, {
      onDelete: "set null",
    }),
    /** Plain text of the text parts, written by the app, for searching history. */
    searchText: text("search_text").default("").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** When a Stop was asked for; the owning process reads it and saves the Run as `stopped` (ADR 0006). */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    /** Last sign of life from the process running a `streaming` Message (ADR 0006). */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** The Run this Message is on: 1 for its first, one more for each decision on a waiting call (ADR 0008). */
    runNumber: integer("run_number").default(1).notNull(),
    /** The TanStack AI thread of a Message waiting for Approval; the decision resumes it (ADR 0008). */
    threadId: text("thread_id"),
    /** The Run that ended waiting for Approval; the decision resumes it as its parent Run (ADR 0008). */
    interruptedRunId: text("interrupted_run_id"),
  },
  (table) => [
    index("message_conversation_id_parent_id_idx").on(table.conversationId, table.parentId),
    index("message_search_text_trgm_idx").using("gin", table.searchText.op("public.gin_trgm_ops")),
  ],
);

export type ConversationRow = typeof conversation.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
