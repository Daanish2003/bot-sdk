import { sql } from "drizzle-orm";
import { type AnyPgColumn, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Type only: the column's type is the assistant's parts union until the row types are composed from the plugins.
import type { StoredParts } from "../../../plugins/assistant/shared/message-parts";
import { attachment, messageAttachment } from "./attachment";
import { blob } from "./blob";
import { chatSchema } from "./chat-schema";
import type { IndexColumns, PluginSchema } from "./plugin-schema";
import { conversation, message } from "./schema";

export * from "./attachment";
export * from "./blob";

export const messageRole = chatSchema.enum("message_role", ["user", "assistant"]);
export const messageStatus = chatSchema.enum("message_status", [
  "streaming",
  "complete",
  "stopped",
  "error",
  "awaiting_approval",
]);
/** A Rating's thumb. The latest one only; null on the column means unrated. */
export const messageRating = chatSchema.enum("message_rating", ["up", "down"]);
export const messageErrorReason = chatSchema.enum("message_error_reason", [
  "invalid_key",
  "rate_limited",
  "provider_error",
]);

/** The core's columns of a Conversation, owned by one user. Its Messages form a tree (ADR 0001). */
const conversationColumns = {
  /** uuidv7, generated in app code. */
  id: uuid("id").primaryKey(),
  /** The Host's user id. The SDK trusts `getUser` and keeps no foreign key to the user. */
  userId: text("user_id").notNull(),
  /** The id of the plugin that owns the Conversation (`"assistant"`, `"bot"`). Each plugin reads only its own. */
  kind: text("kind").notNull(),
  title: text("title"),
  /** The newest Message of the Active Branch. */
  activeLeafId: uuid("active_leaf_id").references((): AnyPgColumn => message.id, {
    onDelete: "set null",
  }),
  /** When the Conversation was pinned; null when it is not pinned. */
  pinnedAt: timestamp("pinned_at"),
  /** When the Conversation was archived; null when it is not. Archiving never deletes it. */
  archivedAt: timestamp("archived_at"),
  /** Bumped only by new Messages, never by renames or Branch switches. */
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
};

/** The core's columns of one Message of a Conversation. Several roots are allowed; there is no hidden root. */
const messageColumns = {
  /** uuidv7, generated in app code; client ids are ignored. */
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => message.id, {
    onDelete: "cascade",
  }),
  role: messageRole("role").notNull(),
  parts: jsonb("parts").$type<StoredParts>().notNull(),
  status: messageStatus("status").notNull(),
  error: text("error"),
  errorReason: messageErrorReason("error_reason"),
  /** Plain text of the text parts, written by the app, for searching history. */
  searchText: text("search_text").default("").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /** The owner's Rating of an ended assistant reply; null when unrated (see **Rating** in CONTEXT.md). */
  rating: messageRating("rating"),
  /** When `rating` was last set; null when unrated. */
  ratedAt: timestamp("rated_at", { withTimezone: true }),
};

/** The core's schema module: the core's half of Conversation and Message, attachments and blobs. */
export const coreSchema = {
  tables: { attachment, messageAttachment, blob },
  enums: { messageRole, messageStatus, messageRating, messageErrorReason },
  fields: {
    conversation: {
      columns: conversationColumns,
      indexes: (table: IndexColumns<typeof conversationColumns>) => [
        index("conversation_user_id_last_message_at_idx").on(
          table.userId,
          table.lastMessageAt.desc(),
        ),
        // The Pinned section: a user's pinned Conversations, most recently pinned first.
        index("conversation_pinned_user_id_pinned_at_idx")
          .on(table.userId, table.pinnedAt.desc())
          .where(sql`pinned_at is not null`),
        // The Archived list: a user's archived Conversations, newest Message first.
        index("conversation_archived_user_id_last_message_at_idx")
          .on(table.userId, table.lastMessageAt.desc())
          .where(sql`archived_at is not null`),
        index("conversation_title_trgm_idx").using("gin", table.title.op("public.gin_trgm_ops")),
      ],
    },
    message: {
      columns: messageColumns,
      indexes: (table: IndexColumns<typeof messageColumns>) => [
        index("message_conversation_id_parent_id_idx").on(table.conversationId, table.parentId),
        index("message_search_text_trgm_idx").using(
          "gin",
          table.searchText.op("public.gin_trgm_ops"),
        ),
        // Full-text search over each Message's text, for `search_past_chats` (spec #263).
        index("message_search_text_fts_idx").using(
          "gin",
          sql`to_tsvector('simple', ${table.searchText})`,
        ),
      ],
    },
  },
} satisfies PluginSchema;
