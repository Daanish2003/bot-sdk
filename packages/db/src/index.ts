import { drizzle } from "drizzle-orm/node-postgres";

import type { DatabaseConfig } from "./config";
import { relations } from "./relations";

export { eq } from "drizzle-orm";

export function createDb(env: DatabaseConfig) {
  return drizzle(env.DATABASE_URL, { relations });
}

export type Database = ReturnType<typeof createDb>;
