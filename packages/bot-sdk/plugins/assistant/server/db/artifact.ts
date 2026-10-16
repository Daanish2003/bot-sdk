import {
  type AnyPgColumn,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { artifactKinds } from "../../../../core/shared/chat/artifact";
import { chatSchema } from "../../../../core/server/db/chat-schema";
import { conversation, message } from "../../../../core/server/db/schema";

/** The kinds of Artifact (ADR 0016). */
export const artifactKind = chatSchema.enum("artifact_kind", artifactKinds);

/**
 * An Artifact, made in one Conversation (ADR 0016). Its versions are rows of `artifact_version`,
 * each belonging to the Message that wrote it. Goes with its Conversation.
 */
export const artifact = chatSchema.table(
  "artifact",
  {
    /** A short id the server makes; the Model uses it to update the Artifact. */
    id: text("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
    kind: artifactKind("kind").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("artifact_conversation_id_idx").on(table.conversationId)],
);

/**
 * One version of an Artifact: its full content, never a diff (ADR 0016). Numbered along the path
 * of Messages it was written on. Goes with the Message that wrote it.
 */
export const artifactVersion = chatSchema.table(
  "artifact_version",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    /** The language of a `code` Artifact; null for the other kinds. */
    language: text("language"),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.messageId, table.number] }),
    index("artifact_version_message_id_idx").on(table.messageId),
  ],
);

export type ArtifactRow = typeof artifact.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersion.$inferSelect;
