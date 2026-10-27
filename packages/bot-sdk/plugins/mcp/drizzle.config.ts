import { defineConfig } from "drizzle-kit";

// The `mcp` feature's own migrations (spec #874): its tables only, beside the core's.
export default defineConfig({
  schema: "./plugins/mcp/server/db/connection.ts",
  out: "./plugins/mcp/server/migrations",
  dialect: "postgresql",
  schemaFilter: ["botsdk"],
});
