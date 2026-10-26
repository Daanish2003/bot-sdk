import type { PluginSchema } from "../plugin-schema";
import { computer, computerState } from "./computer";

export * from "./computer";

/** The `computer` plugin's schema module: its `computer` table. */
export const computerSchema = {
  tables: { computer },
  enums: { computerState },
} satisfies PluginSchema;
