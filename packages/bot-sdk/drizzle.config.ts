import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

// The SDK's own tables, in the fixed `chat` schema. Better Auth's tables are packages/db's.
export default defineConfig({
  // A feature's tables are listed beside the core's: they are not part of its composed schema.
  schema: ["./core/server/db/schema.ts", "./plugins/mcp/server/db/connection.ts"],
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
