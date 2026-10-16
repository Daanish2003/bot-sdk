import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatSchema } from "../../../core/server/db/chat-schema";
import type { coreSchema } from "../../../core/server/db/core-schema";
import type { IndexColumns, PluginSchema } from "../../../core/server/db/plugin-schema";
import { message } from "../../../core/server/db/schema";
import type { ConversationTools } from "../../../core/shared/chat/conversation-tools";
import type { MessageUsage } from "../../../core/shared/chat/message-record";
import { artifact, artifactKind, artifactVersion } from "./db/artifact";
import { mcpConnection } from "./db/connection";
import { generatedImage } from "./db/generated-image";
import { job, jobStatus } from "./db/job";
import { knowledgeChunk, knowledgeFile, knowledgeFileStatus } from "./db/knowledge";
import { memory, memoryOrigin } from "./db/memory";
import { project } from "./db/project";
import { savedPrompt } from "./db/saved-prompt";
import { userSettings } from "./db/settings";
import { sharedLink } from "./db/share";

export type { MessageUsage };
export * from "./db/artifact";
export * from "./db/connection";
export * from "./db/generated-image";
export * from "./db/job";
export * from "./db/knowledge";
export * from "./db/memory";
export * from "./db/project";
export * from "./db/saved-prompt";
export * from "./db/settings";
export * from "./db/share";

/** How hard a reasoning Model thinks. Null means the Model's own default. */
export const reasoningEffort = chatSchema.enum("reasoning_effort", [
  "off",
  "low",
  "medium",
  "high",
]);

/** The assistant's columns on a Conversation. */
const conversationColumns = {
  /** The selected Model, `"provider:model"`; checked in code, not an enum. */
  model: text("model").notNull(),
  /** The effort the Conversation asks for; null means the Model's default. */
  reasoningEffort: reasoningEffort("reasoning_effort"),
  /** The Project this Conversation is in; null when it is in none. Deleting it deletes this. */
  projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
  /** The MCP tools switched on here: its Connections and allowed tools (spec #91). */
  toolSettings: jsonb("tool_settings")
    .$type<ConversationTools>()
    .default(sql`'{"connections": [], "allowedTools": []}'::jsonb`)
    .notNull(),
  /** A Temporary Conversation: kept out of the lists, search and titles. Set at creation only. */
  temporary: boolean("temporary").default(false).notNull(),
};

/** The assistant's columns on a Message. */
const messageColumns = {
  /** The Model that wrote an assistant Message; null for user Messages. */
  model: text("model"),
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
  /** When the Host's output check hid this reply; null while it is shown (#268). */
  hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  /** The reason the Host gave for hiding the reply, when it gave one (#268). */
  hiddenReason: text("hidden_reason"),
};

type CoreConversationColumns = typeof coreSchema.fields.conversation.columns;

/** The `assistant` plugin's schema module: every other `chat` table, and its fields on the core tables. */
export const assistantSchema = {
  tables: {
    project,
    artifact,
    artifactVersion,
    mcpConnection,
    generatedImage,
    job,
    knowledgeFile,
    knowledgeChunk,
    memory,
    savedPrompt,
    userSettings,
    sharedLink,
  },
  enums: { reasoningEffort, artifactKind, jobStatus, knowledgeFileStatus, memoryOrigin },
  fields: {
    conversation: {
      columns: conversationColumns,
      indexes: (table: IndexColumns<CoreConversationColumns & typeof conversationColumns>) => [
        // The main list: a user's Conversations that are in no Project, newest first.
        index("conversation_unprojected_user_id_last_message_at_idx")
          .on(table.userId, table.lastMessageAt.desc())
          .where(sql`project_id is null`),
        // A Project's list, newest first.
        index("conversation_project_id_last_message_at_idx").on(
          table.projectId,
          table.lastMessageAt.desc(),
        ),
      ],
    },
    message: { columns: messageColumns },
  },
} satisfies PluginSchema;
