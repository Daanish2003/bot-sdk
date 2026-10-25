import type { PluginSchema } from "../../../core/server/db/plugin-schema";
import { computer, computerState } from "./db/computer";

export * from "./db/computer";

/** The `computer` plugin's schema module: its `computer` table. */
export const computerSchema = {
  tables: { computer },
  enums: { computerState },
} satisfies PluginSchema;
