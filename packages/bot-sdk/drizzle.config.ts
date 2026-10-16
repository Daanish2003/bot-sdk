import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

// The SDK's own tables, in the fixed `chat` schema. Better Auth's tables are packages/db's.
export default defineConfig({
  schema: "./core/server/db/schema/index.ts",
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
