import type { PluginSchema } from "../../../core/server/db/plugin-schema";
import { userCredentials } from "./db/credentials";
import { modelSettings } from "./db/settings";
import { usage, usageKind } from "./db/usage";

export * from "./db/credentials";
export * from "./db/settings";
export * from "./db/usage";

/** The `models` plugin's schema module: its credentials, settings and usage tables. */
export const modelsSchema = {
  tables: { userCredentials, modelSettings, usage },
  enums: { usageKind },
} satisfies PluginSchema;
