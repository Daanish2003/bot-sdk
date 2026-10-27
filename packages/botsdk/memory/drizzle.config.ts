import { defineConfig } from "drizzle-kit";

// The Memory feature's own migrations (spec #874): its tables only, beside the core's.
export default defineConfig({
  schema: "./src/server/schema.ts",
  out: "./src/server/migrations",
  dialect: "postgresql",
  schemaFilter: ["botsdk"],
});
