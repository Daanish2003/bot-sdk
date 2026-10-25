import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

// The SDK's own tables, in the fixed `chat` schema. Better Auth's tables are packages/db's.
export default defineConfig({
  // The Memory feature's table is its own, beside the core's.
  schema: ["./core/server/db/schema.ts", "./plugins/memory/server/schema.ts"],
  out: "./core/server/migrations",
  dialect: "postgresql",
  schemaFilter: ["chat"],
  migrations: {
    table: "__migrations",
    schema: "chat",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
