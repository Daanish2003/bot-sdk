import { defineConfig } from "drizzle-kit";

// The Memory feature's own migrations (spec #874): its tables only, beside the core's.
export default defineConfig({
  schema: "./plugins/memory/server/schema.ts",
  out: "./plugins/memory/server/migrations",
  dialect: "postgresql",
  schemaFilter: ["botsdk"],
});
