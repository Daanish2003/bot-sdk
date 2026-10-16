/// <reference types="node" />
/**
 * The chat half of `db:migrate`: creates the `chat` schema and applies the Bot SDK's migrations.
 * `prisma migrate deploy` runs first and owns `public`. This is the same function `chat.migrate()`
 * calls; it is imported directly because Node can run this file without a bundler, and the SDK's
 * other files use extensionless imports that Node can't resolve.
 */
import { migrate } from "../src/bot-sdk/core/server/migrate.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");

await migrate(databaseUrl);
console.log("The chat schema is migrated.");
