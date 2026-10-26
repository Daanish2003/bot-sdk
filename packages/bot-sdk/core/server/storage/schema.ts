import { botSchema } from "./bot/schema";
import { channelSchema } from "./channel/schema";
import { computerSchema } from "./computer/schema";
import { modelsSchema } from "./models/schema";
import { runnerSchema } from "./runner/schema";
import { botsdkSchema } from "./botsdk-schema";
import {
  conversationColumns,
  conversationIndexes,
  coreSchema,
  messageColumns,
  messageIndexes,
} from "./core-schema";
import { assertNoClashes, type NamedPluginSchema } from "./plugin-schema";

/*
 * The composed `botsdk` schema: the core plus every plugin in the package. drizzle-kit, the
 * relations and all SDK code import tables from here, never from a plugin's schema module.
 */
export * from "./core-schema";
export * from "./models/schema";
export * from "./runner/schema";
export * from "./bot/schema";
export * from "./computer/schema";
export * from "./channel/schema";

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
export const conversation = botsdkSchema.table(
  "conversation",
  conversationColumns,
  conversationIndexes,
);

/** One Message of a Conversation. Several roots are allowed; there is no hidden root. */
export const message = botsdkSchema.table("message", messageColumns, messageIndexes);

export type ConversationRow = typeof conversation.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
