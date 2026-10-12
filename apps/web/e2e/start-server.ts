/// <reference types="node" />
/**
 * The end-to-end run's web server: creates the e2e database if missing, migrates and empties
 * it, then runs the production build (`.output`) in this process. Run by Playwright's
 * `webServer` with `serverEnv`; plain Node (type stripping), so imports keep their extensions.
 * It also starts a second copy of the build, on its own port, with `mcpServerEnv`: the one that
 * offers an MCP server. Both share the database.
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { e2eDatabaseUrl } from "./database.ts";
import { mcpServerEnv } from "./env.ts";

// `pg` and Drizzle are the db package's dependencies, not the web app's.
const dbRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const { Client } = dbRequire("pg");
const { drizzle } = dbRequire("drizzle-orm/node-postgres");

const databaseUrl = e2eDatabaseUrl();
process.env.DATABASE_URL = databaseUrl;

async function createDatabaseIfMissing() {
  const server = new URL(databaseUrl);
  const name = decodeURIComponent(server.pathname.slice(1));
  server.pathname = "/postgres";
  const client = new Client({ connectionString: server.toString() });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
}

/** The app's own migrate script: Better Auth's tables, then the chat schema. */
async function runMigrateScript() {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/migrate.ts", import.meta.url))],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    },
  );
}

/** Empties the app's tables and the chat schema's, but not the chat migration journal. */
async function empty() {
  // Drizzle opens its own pool: it doesn't recognise a client from another copy of `pg`.
  const db = drizzle(databaseUrl);
  try {
    const { rows } = await db.$client.query(
      `select schemaname, tablename from pg_tables
       where schemaname = 'public' or (schemaname = 'chat' and tablename <> '__migrations')`,
    );
    const tables = rows.map(
      ({ schemaname, tablename }: { schemaname: string; tablename: string }) =>
        `"${schemaname}"."${tablename}"`,
    );
    if (tables.length > 0) await db.$client.query(`truncate table ${tables.join(", ")} cascade`);
  } finally {
    await db.$client.end();
  }
}

await createDatabaseIfMissing();
await runMigrateScript();
await empty();

const serverEntry = fileURLToPath(new URL("../.output/server/index.mjs", import.meta.url));

// The MCP server's copy runs as a child process: the production build listens at import, so
// two copies can't share this process. Playwright stops this one, and the child with it.
const mcpCopy = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, ...mcpServerEnv },
  stdio: "inherit",
});
process.on("exit", () => mcpCopy.kill());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit());

await import(pathToFileURL(serverEntry).href);
