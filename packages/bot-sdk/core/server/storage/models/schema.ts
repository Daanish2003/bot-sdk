import type { PluginSchema } from "../plugin-schema";
import { userCredentials } from "./credentials";
import { modelSettings } from "./settings";
import { usage, usageKind } from "./usage";

export * from "./credentials";
export * from "./settings";
export * from "./usage";

/** The `models` plugin's schema module: its credentials, settings and usage tables. */
export const modelsSchema = {
  tables: { userCredentials, modelSettings, usage },
  enums: { usageKind },
} satisfies PluginSchema;
