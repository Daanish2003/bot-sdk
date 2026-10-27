// The storage service's entry point (#889): the tables, the database client and the blob stores.
export * from "./schema";
export * as schema from "./schema";
export { postgresBlobStore } from "./blob/postgres";
export { type BlobStore, deleteBlobsBestEffort } from "./blob/store";
export type { PromptStartSection, PromptStartTool } from "./bot/bot-prompt-start";
export { botsdkSchema } from "./botsdk-schema";
export { databaseOf, type Database } from "./client";
export { assertNoClashes, type NamedPluginSchema } from "./plugin-schema";
export { relations } from "./relations";
