import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

// The core's tables, in the fixed `botsdk` schema. Better Auth's tables are packages/db's. Each
// feature with tables has its own config in its own package (`packages/botsdk/<id>/drizzle.config.ts`), so
// its migrations are its own (spec #874); `pnpm db:generate` runs them all.
export default defineConfig({
  schema: "./src/storage/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  schemaFilter: ["botsdk"],
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
