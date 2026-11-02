import { defineConfig } from "drizzle-kit";

// The `representative` feature's own migrations (spec #874): its tables only, beside the core's.
export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./src/server/migrations",
  dialect: "postgresql",
  schemaFilter: ["botsdk"],
});
