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
  uuid,
} from "drizzle-orm/pg-core";

import { chatSchema } from "../../../core/server/db/chat-schema";
import type { coreSchema } from "../../../core/server/db/core-schema";
import type { IndexColumns, PluginSchema } from "../../../core/server/db/plugin-schema";
import { message } from "../../../core/server/db/schema";
import type { MessageUsage } from "../../models/shared/usage";
import { artifact, artifactKind, artifactVersion } from "./db/artifact";
import { generatedImage } from "./db/generated-image";
import { project } from "./db/project";
import { savedPrompt } from "./db/saved-prompt";
import { userSettings } from "./db/settings";
import { sharedLink } from "./db/share";

export type { MessageUsage };
export * from "./db/artifact";
export * from "./db/generated-image";
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
  /**
   * The selected Model, `"provider:model"`; checked in code, not an enum. Null only on another
   * plugin's Conversation: a CHECK keeps it set on every assistant one.
   */
  model: text("model"),
  /** The effort the Conversation asks for; null means the Model's default. */
  reasoningEffort: reasoningEffort("reasoning_effort"),
  /** The Project this Conversation is in; null when it is in none. Deleting it deletes this. */
  projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
  /**
   * The MCP tools once switched on here (spec #91). Unused since the `mcp` plugin took MCP over
   * (ADR 0027); spec 3 drops it.
   */
  toolSettings: jsonb("tool_settings")
    .$type<{ connections: string[]; allowedTools: string[] }>()
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
    generatedImage,
    savedPrompt,
    userSettings,
    sharedLink,
  },
  enums: { reasoningEffort, artifactKind },
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
        check(
          "conversation_assistant_model_check",
          sql`${table.kind} <> 'assistant' OR ${table.model} IS NOT NULL`,
        ),
      ],
    },
    message: { columns: messageColumns },
  },
} satisfies PluginSchema;
