import type { PartsEnvelope } from "@botsdk/client/message-parts";
import {
  type AnyPgColumn,
  type ExtraConfigColumn,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { blob } from "./blob";
import { botsdkSchema } from "./botsdk-schema";
import { conversationChange } from "./conversation-change";
import type { PluginSchema } from "./plugin-schema";
import { bot, conversation, message } from "./schema";

export * from "./blob";
export * from "./conversation-change";

/**
 * Who wrote a Message: the user or a Bot (`assistant`). A `reset` Message is written by neither:
 * it is the reset mark a Bot reset appends (spec #1007), and the Bot sees nothing from before it.
 */
export const messageRole = botsdkSchema.enum("message_role", ["user", "assistant", "reset"]);
export const messageStatus = botsdkSchema.enum("message_status", [
  "streaming",
  "complete",
  "stopped",
  "error",
  "awaiting_approval",
]);
export const messageErrorReason = botsdkSchema.enum("message_error_reason", [
  "invalid_key",
  "rate_limited",
  "provider_error",
]);

/** The columns of a Conversation, owned by one user. Its Messages form a tree (ADR 0001). */
export const conversationColumns = {
  /** uuidv7, generated in app code. */
  id: uuid("id").primaryKey(),
  /** The Host's user id. The SDK trusts `getUser` and keeps no foreign key to the user. */
  userId: text("user_id").notNull(),
  /** The id of the plugin that owns the Conversation (`"bot"`). Each plugin reads only its own. */
  kind: text("kind").notNull(),
  title: text("title"),
  /** The newest Message of the Active Branch. */
  activeLeafId: uuid("active_leaf_id").references((): AnyPgColumn => message.id, {
    onDelete: "set null",
  }),
  /** Bumped only by new Messages, never by renames or Branch switches. */
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
  /** The seq of the newest change in its change log (ADR 0026); 0 before the first. */
  lastSeq: integer("last_seq").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
};

/** The columns of one Message of a Conversation. Several roots are allowed; there is no hidden root. */
export const messageColumns = {
  /** uuidv7, generated in app code; client ids are ignored. */
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => message.id, {
    onDelete: "cascade",
  }),
  role: messageRole("role").notNull(),
  /**
   * The Bot that wrote an `assistant` Message (spec #1055), in a 1:1 Conversation or a Room; null
   * for the user's Messages and reset marks, and once that Bot is deleted.
   */
  authorBotId: uuid("author_bot_id").references((): AnyPgColumn => bot.id, {
    onDelete: "set null",
  }),
  parts: jsonb("parts").$type<PartsEnvelope>().notNull(),
  status: messageStatus("status").notNull(),
  error: text("error"),
  errorReason: messageErrorReason("error_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
};

type IndexColumns<Columns> = { [K in keyof Columns]: ExtraConfigColumn };

/** The indexes of `conversation`. */
export const conversationIndexes = (table: IndexColumns<typeof conversationColumns>) => [
  index("conversation_user_id_last_message_at_idx").on(table.userId, table.lastMessageAt.desc()),
];

/** The indexes of `message`. */
export const messageIndexes = (table: IndexColumns<typeof messageColumns>) => [
  index("message_conversation_id_parent_id_idx").on(table.conversationId, table.parentId),
];

/** The core's schema module besides Conversation and Message: blobs and the change log. */
export const coreSchema = {
  tables: { blob, conversationChange },
  enums: { messageRole, messageStatus, messageErrorReason },
} satisfies PluginSchema;
