import { botSchema } from "../../../plugins/bot/server/schema";
import { channelSchema } from "../../../plugins/channel/server/schema";
import { computerSchema } from "../../../plugins/computer/server/schema";
import { modelsSchema } from "../../../plugins/models/server/schema";
import { runnerSchema } from "../../../plugins/runner/server/schema";
import { chatSchema } from "./chat-schema";
import {
  conversationColumns,
  conversationIndexes,
  coreSchema,
  messageColumns,
  messageIndexes,
} from "./core-schema";
import { assertNoClashes, type NamedPluginSchema } from "./plugin-schema";

/*
 * The composed `chat` schema: the core plus every plugin in the package. drizzle-kit, the
 * relations and all SDK code import tables from here, never from a plugin's schema module.
 */
export * from "./core-schema";
export * from "../../../plugins/models/server/schema";
export * from "../../../plugins/runner/server/schema";
export * from "../../../plugins/bot/server/schema";
export * from "../../../plugins/computer/server/schema";
export * from "../../../plugins/channel/server/schema";

const schemas: NamedPluginSchema[] = [
  { id: "core", schema: coreSchema },
  { id: "models", schema: modelsSchema },
  { id: "runner", schema: runnerSchema },
  { id: "bot", schema: botSchema },
  { id: "computer", schema: computerSchema },
  { id: "channel", schema: channelSchema },
];
assertNoClashes(schemas);

/** A Conversation, owned by one user. Its Messages form a tree (ADR 0001). */
export const conversation = chatSchema.table(
  "conversation",
  conversationColumns,
  conversationIndexes,
);

/** One Message of a Conversation. Several roots are allowed; there is no hidden root. */
export const message = chatSchema.table("message", messageColumns, messageIndexes);

export type ConversationRow = typeof conversation.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
