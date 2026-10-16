# Research: Drizzle with one migrations journal per schema

Ticket: [#429 Drizzle with one migrations journal per schema](https://github.com/Daanish2003/ai-chat/issues/429) (child of map [#411](https://github.com/Daanish2003/ai-chat/issues/411)).
Researched: 2026-10-16, from the installed `drizzle-orm@1.0.0-rc.4` and `drizzle-kit@1.0.0-rc.4` (the versions in `pnpm-lock.yaml`), the Postgres docs and the Postgres source.

Facts only. Nothing here is a decision; the choices go to the grilling ticket (#431).

## Question

[ADR 0019](../adr/0019-a-family-of-copied-sdks.md) gives each SDK its own Postgres schema, SQL migrations and `migrate()`. How does Drizzle behave when several `migrate()` calls (from `drizzle-orm/node-postgres/migrator`) each use their own `migrationsSchema`, and in what order do they run? What happens when a migration in one SDK's journal moves a table into a schema that a newer SDK owns? How does `drizzle-kit generate` (with `schemaFilter` in the config) treat a table that already exists after `ALTER TABLE ... SET SCHEMA`, so the next generate neither recreates nor drops it? And how does the `assertMigrated()` / `LATEST_MIGRATION` pattern in `packages/chat-sdk/core/server/migrate.ts` carry over?

## Answer

- **Each `migrate()` call is independent.** It reads one folder, keeps its journal in `<migrationsSchema>.<migrationsTable>`, and applies the migrations that table doesn't list yet, all in one transaction. Drizzle doesn't coordinate journals, take any lock, or order calls. The Host's call order is the only order.
- **A journal decides what's pending by migration name, not by timestamp.** A folder with an older timestamp that arrives later is still applied. `created_at` is written but no longer read to decide what to run.
- **Moving a table across journals is plain SQL to Drizzle.** A migration in SDK A's folder may run `ALTER TABLE "chat"."x" SET SCHEMA "memory"`. Drizzle neither checks nor records which schema a statement touches. The target schema must already exist when that statement runs.
- **`drizzle-kit generate` never reads the database, and ignores `schemaFilter`.** It diffs the TypeScript schema files against the newest `snapshot.json` in that config's `out` folder. If a table is deleted from SDK A's schema files and added to SDK B's, A's next generate emits `DROP TABLE` and B's emits `CREATE TABLE`. A `--custom` migration copies the previous snapshot unchanged, so it doesn't fix this on its own.
- **`assertMigrated()` carries over per SDK** with its own `LATEST_MIGRATION` and its own `<schema>.__migrations`. It compares `max(created_at)` against the newest folder's timestamp, while Drizzle compares names. The two agree as long as the newest folder is always the newest by timestamp.

## The runtime migrator (`drizzle-orm` 1.0.0-rc.4)

Source: `node_modules/.pnpm/drizzle-orm@1.0.0-rc.4_…/node_modules/drizzle-orm/`.

### What one `migrate()` call does

- `node-postgres/migrator.js`: `migrate(db, config)` = `migrate$1(readMigrationFiles(config), db, config)`. `config` is `{ migrationsFolder, migrationsTable?, migrationsSchema? }` (`migrator.d.ts`, `MigrationConfig`).
- `migrator.js` `readMigrationFiles`:
  - Throws if `<folder>/meta/_journal.json` exists ("old drizzle-kit migration folders… run `drizzle-kit up`"). The repo's folders are the new layout, one sub-folder per migration with `migration.sql` and `snapshot.json` (`packages/chat-sdk/core/server/migrations/*`).
  - Lists the sub-folders that contain `migration.sql`, sorts them with `a.name.localeCompare(b.name)`, splits each file on `--> statement-breakpoint`, and records `folderMillis` (from the first 14 characters), `hash` (sha256 of the file) and `name` (the folder name).
  - It never reads `snapshot.json`.
- `pg-core/async/session.js` `migrate(migrations, db, config)`:
  1. Defaults: table `__drizzle_migrations`, schema `drizzle`.
  2. Runs `CREATE SCHEMA IF NOT EXISTS "<migrationsSchema>"` **on every call**.
  3. `upgradeIfNeeded` (`up-migrations/pg.js`): if the journal table exists without a `name` column (version 0), it adds `name` and `applied_at` and fills `name` by matching rows to local folders on `created_at`, then on `hash`. It throws if a row matches no local folder.
  4. Creates the journal if missing: `id serial`, `hash text not null`, `created_at bigint`, `name text`, `applied_at timestamptz default now()`.
  5. Selects all rows, then `getMigrationsToRun` (`migrator.utils.js`) keeps the local migrations whose `name` is **not** in the set of journal names.
  6. In **one `db.transaction`**, runs each pending migration's statements and inserts `(hash, created_at = folderMillis, name)` after each one. A failure rolls back every migration of that call.
- There is no advisory lock and no check of the hashes of migrations that were already applied. Editing an applied `migration.sql` goes unnoticed.

### Several journals in one database

- Each call is scoped to its `migrationsFolder` and `<migrationsSchema>.<migrationsTable>`. Nothing in the code reads another journal, so two SDKs with tables `chat.__migrations` and `memory.__migrations` don't see each other.
- **Ordering** is just the order the Host awaits the calls. Each call commits its own transaction, so there's no atomicity across SDKs. If the second call fails, the first stays applied.
- **Concurrency**: Drizzle has no lock. The repo's `migrate()` holds `pg_advisory_lock(727_770_001)` around its own call (`MIGRATION_LOCK_ID` in `migrate.ts`). Whether several SDKs share one lock id or use one each is up to them.
- **Schema creation and privileges.** Because step 2 always runs `CREATE SCHEMA IF NOT EXISTS`, the migrate role needs `CREATE` on the database even when the schema already exists. Postgres checks that privilege **before** it checks `IF NOT EXISTS`: in `CreateSchemaCommand` the `object_aclcheck(DatabaseRelationId, MyDatabaseId, saved_uid, ACL_CREATE)` comes before the `if (stmt->if_not_exists)` branch ([schemacmds.c, master](https://github.com/postgres/postgres/blob/master/src/backend/commands/schemacmds.c)); "To create a schema, the invoking user must have the `CREATE` privilege for the current database" ([CREATE SCHEMA](https://www.postgresql.org/docs/current/sql-createschema.html)). This seems to undercut the comment on `createChatSchema` in `migrate.ts` ("so a Host may create it itself with fewer rights"). **Not tested** against a live database, and only checked on Postgres `master`, not each release branch.

## A migration that moves a table into another SDK's schema

- Postgres: `ALTER TABLE name SET SCHEMA new_schema` "moves the table into another schema. Associated indexes, constraints, and sequences owned by table columns are moved as well." You must own the table and "have `CREATE` privilege on the new schema" ([ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)).
- To Drizzle it is just one more statement in a `migration.sql`. The journal records the folder name and hash in the journal of the `migrate()` call that ran it, which is the journal of the folder that holds the file.
- **Precondition: the target schema exists.** It can come from:
  - a `CREATE SCHEMA IF NOT EXISTS "memory"` earlier in the same migration, or
  - a `memory.migrate()` that ran first, since step 2 creates `memory` before its migrations. If those migrations also `CREATE TABLE "memory"."x"`, the later `SET SCHEMA` fails, because the name is already taken in `memory`.
- **A fresh database replays the full history.** Each journal applies every folder in name order. A fresh install runs SDK A's old `CREATE TABLE "chat"."x"`, and later its move, in the same order an upgraded database did. That holds only if the Host calls the `migrate()`s in the same relative order on both.
- **Constraints that move with the table and still point back.** Today `chat.memory.conversation_id` has a foreign key to `chat.conversation`, and `chat.knowledge_file.project_id` has one to `chat.project` (`20261014150000_memory/migration.sql` line 21, `20261014140000_knowledge/migration.sql` line 30). After `SET SCHEMA` they stay as foreign keys across schemas. ADR 0019 says references across SDKs have no foreign keys, so dropping them would be a separate statement.

## `drizzle-kit generate` (1.0.0-rc.4)

Source: `node_modules/.pnpm/drizzle-kit@1.0.0-rc.4/node_modules/drizzle-kit/bin.cjs`.

- **Config it reads.** `prepareGenerateConfig` (line ~89297) takes only `schema`, `out`, `breakpoints`, `dialect`, `driver` and the CLI flags (`name`, `custom`, `explain`, hints). It does **not** read `schemaFilter`, `tablesFilter`, `migrations` or `dbCredentials`. Those are used by `push` and `pull` (`preparePushConfig` / `preparePullConfig` build `filters: { schemas: config.schemaFilter, … }`, lines ~89376 and ~89497). So in `packages/chat-sdk/drizzle.config.ts`, `schemaFilter: ["chat"]` and `migrations: { table, schema }` have no effect on `generate`.
- **What it diffs.** `handle$17` (Postgres generate, line ~91547):
  - `prepareOutFolder(out)` lists the `snapshot.json` files and sorts them.
  - `prepareSnapshot$4` takes the **last** snapshot as "previous" (or a branch parent from `check` when there are several leaves), and builds "current" from the schema files with `fromDrizzleSchema$4(prepared, () => true)`, which keeps every table in every schema.
  - It never looks at the database.
- **How it decides between moving and dropping.** `ddlDiff$4` (line ~83614) diffs the tables, then calls the table resolver. `resolver` (line ~91407) returns early with no renames or moves when either the created or the deleted list is empty. Only when both are non-empty in **the same diff** does it ask (TTY) or read hints whether that's a rename or move. A move becomes a `move_table` statement, `ALTER TABLE "<from>"."<name>" SET SCHEMA "<to>";` (`moveTableConvertor$1`, line ~83200).
- **So with one config per SDK:**
  - SDK A's config no longer has `x` in its schema files. Its diff has `x` only as deleted, so it emits `DROP TABLE "chat"."x"`.
  - SDK B's config has `x` new in `memory`. Its diff has it only as created, so it emits `CREATE SCHEMA "memory"` (if new) and `CREATE TABLE "memory"."x"` with its indexes.
  - Neither generate can produce the `SET SCHEMA` by itself, because the move spans two `out` folders. A single generate over a config that covers both schemas would detect it (via the resolver prompt).
- **`--custom`.** It writes an empty `migration.sql` with a snapshot whose `ddl` is the **previous** snapshot's, with a new id (`custom: { id, prevIds, ...prevRest }`). A hand-written `SET SCHEMA` in a custom migration therefore leaves that folder's snapshot still listing the old table, and the next normal generate diffs against that.
- **Snapshot and SQL are decoupled.** `generate` reads only `snapshot.json`, and the runtime migrator reads only `migration.sql` (both shown above). Derived from the code, not stated in the docs: a folder whose `snapshot.json` reflects the new schema files, but whose `migration.sql` holds different SQL (for example the `SET SCHEMA` in place of a `DROP` or `CREATE`), makes the next generate see no change for that table. **Not tested end to end.**
- `generate` refuses an old layout too (`assertV3OutFolder` throws on `meta/_journal.json`).

## How `assertMigrated()` / `LATEST_MIGRATION` carries over

What it does today (`packages/chat-sdk/core/server/migrate.ts`):

- `LATEST_MIGRATION` is the newest folder name, hardcoded because a bundle can't read the folder. A test keeps it equal to `readdirSync(...).sort().at(-1)` (`packages/chat-sdk/test/core/server/migrate.integration.test.ts` line ~465).
- `assertMigrated()` checks `to_regclass('chat.__migrations')`, reads `max(created_at)`, and throws if that's below `folderMillis(LATEST_MIGRATION)`. `start()` calls it (`create-chat.ts` line 419).
- `folderMillis` matches Drizzle's `formatToMillis` (`migrator.utils.js`), the value Drizzle writes into `created_at`.

How it maps onto Drizzle rc.4:

- Drizzle runs migrations by **name** and writes `created_at = folderMillis`. `max(created_at) >= latest` is therefore true once the newest folder has been applied, because every `migrate()` applies all pending folders in one transaction.
- It does **not** notice a missing older folder, but Drizzle can't leave one out either, since every call applies all pending folders or rolls back.
- It relies on the newest folder also having the highest timestamp prefix. `readMigrationFiles` sorts by `localeCompare` on the name, and the test sorts with `.sort()`. With the fixed `yyyymmddhhmmss_` prefix those agree.
- Per SDK, the same pattern needs only that SDK's schema-qualified journal (`<schema>.__migrations`) and its own `LATEST_MIGRATION` and test. Nothing in Drizzle stops each SDK's `start()` from checking only its own journal. A check that SDK A's move has run before SDK B starts would need B to read A's journal, or check the table's schema in `pg_class`/`pg_namespace`. Drizzle offers no such check.

## Not verified

- No end-to-end run of two `migrate()` calls with a table move between journals. Everything above is from reading the installed code.
- That the `CREATE SCHEMA IF NOT EXISTS` privilege check fails for a role that lacks database `CREATE` when the schema already exists. This comes from reading the Postgres source on `master`, not from a test.
- Whether editing a generated `migration.sql` while keeping its `snapshot.json` is a supported workflow in Drizzle's docs. Only the code behaviour was checked.
