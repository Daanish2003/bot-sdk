import { getTableConfig } from "drizzle-orm/pg-core";

import { assistantSchema } from "../../../plugins/assistant/server/schema";
import { botSchema } from "../../../plugins/bot/server/schema";
import { computerSchema } from "../../../plugins/computer/server/schema";
import { modelsSchema } from "../../../plugins/models/server/schema";
import { runnerSchema } from "../../../plugins/runner/server/schema";
import { chatSchema } from "./chat-schema";
import { coreSchema } from "./core-schema";
import { assertNoClashes, composeIndexes, type NamedPluginSchema } from "./plugin-schema";

/*
 * The composed `chat` schema: the core plus every plugin in the package. drizzle-kit, the
 * relations and all SDK code import tables from here, never from a plugin's schema module.
 */
export * from "./core-schema";
export * from "../../../plugins/models/server/schema";
export * from "../../../plugins/runner/server/schema";
export * from "../../../plugins/assistant/server/schema";
export * from "../../../plugins/bot/server/schema";
export * from "../../../plugins/computer/server/schema";

const schemas: NamedPluginSchema[] = [
  { id: "core", schema: coreSchema },
  { id: "models", schema: modelsSchema },
  { id: "runner", schema: runnerSchema },
  { id: "assistant", schema: assistantSchema },
  { id: "bot", schema: botSchema },
  { id: "computer", schema: computerSchema },
];
assertNoClashes(schemas);

// `models`, `runner`, `bot` and `computer` add no fields to the core tables, so only the core's and the assistant's are spread.

/** A Conversation, owned by one user. Its Messages form a tree (ADR 0001). */
export const conversation = chatSchema.table(
  "conversation",
  { ...coreSchema.fields.conversation.columns, ...assistantSchema.fields.conversation.columns },
  composeIndexes("conversation", schemas),
);

/** One Message of a Conversation. Several roots are allowed; there is no hidden root. */
export const message = chatSchema.table(
  "message",
  { ...coreSchema.fields.message.columns, ...assistantSchema.fields.message.columns },
  composeIndexes("message", schemas),
);

// Builds both index lists now, so a clash between two parts' indexes fails at load.
getTableConfig(conversation);
getTableConfig(message);

export type ConversationRow = typeof conversation.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
