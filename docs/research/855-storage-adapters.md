# Storage adapters and migrations in published libraries

Research for issue #855 (child of the map #853). Researched on 2026-10-25 against the `main` branches and current docs of Better Auth, Mastra, Auth.js, Payload, pg-boss (12.38.0), Graphile Worker (0.18.0) and DBOS Transact (TypeScript).

How to read the sources:

- **Sources.** Each claim links the doc page or source file it comes from. GitHub links point at `main` as read on 2026-10-25, so line contents may drift.
- **Unverified.** Nothing here was run. Points that a doc page did not state and that come only from reading the source are marked **source only**. Points that could not be confirmed are marked **unverified**.

What we use today (counted in `packages/bot-sdk`, non-test files): `FOR UPDATE SKIP LOCKED` in the runner's job store and `plugins/bot/server/files.ts`, `pg_advisory_xact_lock` in `helper.ts` and `memory/server/bot-pass.ts`, a session advisory lock in `core/server/migrate.ts`, `pg_trgm` (created by `migrate.ts`), jsonb columns in 16 files, and `.transaction(` in 25 files.

---

## Recommendation

1. **Don't put our data behind a generic CRUD adapter.** Better Auth's adapter (about 11 methods over `model` + `where[]`) and Payload's (about 50 methods over collections) can't express `SKIP LOCKED`, advisory locks or `pg_trgm`. Better Auth had to add the special-purpose atomic methods `consumeOne` and `incrementOne` to make even single-row races safe. Payload's Postgres job claim uses a compare-and-swap `UPDATE` instead of `SKIP LOCKED`. Both lose what we need.
2. **If we want more than one storage backend, use typed repositories per domain, the way Mastra does.** Mastra's storage is one abstract class per domain (`WorkflowsStorage`, memory, scores and so on), with intent-level methods such as `claimRunOwnership`. Each backend implements them natively, and the Postgres one uses `FOR UPDATE SKIP LOCKED` and `pg_advisory_xact_lock` inside its own methods. Capability flags (`supportsRunFencing()`, `supportsConcurrentUpdates()`) plus a shared conformance suite keep the backends honest.
3. **The simplest option that keeps everything is "Postgres only, the library owns its schema and SQL", the way pg-boss, Graphile Worker and DBOS work.** Our Postgres features then stay as they are. Two cheap seams make this Host-friendly:
   - **Bring your own connection or transaction.** pg-boss takes a `db` object with one `executeSql` method, and ships `fromDrizzle`, `fromKysely`, `fromKnex` and `fromPrisma` wrappers so a job is enqueued inside the Host's transaction. DBOS datasources do the same for Drizzle, Knex, Kysely, Prisma, TypeORM, node-postgres and postgres.js.
   - **Migrations three ways.** Each runs automatically on start by default, can be switched off (`migrate: false` in pg-boss, migrate-on-launch off in DBOS, `runMigrations: false` on a DBOS datasource), and can be run or exported out of band (pg-boss `plans` prints SQL, `npx dbos schema` / `DBOS.migrate`, DBOS `initializeDBOSSchema` inside a Host's Knex migration).
4. **Keep our own versioned migration journal in our own Postgres schema, and keep the advisory lock around it.** pg-boss (`version` table, `pg_advisory_xact_lock`), Graphile Worker (`migrations` table with a `breaking` flag, so an old worker refuses to run against a newer breaking schema) and DBOS (`dbos_migrations`) all do this. We already do it with `chat.__migrations` and `pg_advisory_lock`.
5. **For "only the enabled features' tables", copy Better Auth's per-plugin schema and Mastra's per-domain `init()`, not Payload's.**
   - **Better Auth.** Each plugin declares `schema` tables and fields. The CLI generates Drizzle, Prisma or SQL for whichever plugins are configured, and `migrate` applies it only for the built-in Kysely adapter. For Drizzle and Prisma the **Host** owns and runs the migrations.
   - **Mastra.** Each configured domain runs `init()` (idempotent `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`). A domain set to `false` creates no tables.
   - **The fit for us.** A per-feature migration folder, each folder with its own journal row prefix, run only for enabled features. This sits between Better Auth's "Host owns the migrations" and Mastra's runtime DDL, and it keeps reviewable SQL files. That shape is an inference from these designs, not something any of them ships.
6. **Test adapters with a shared conformance suite run against every backend.** Better Auth (`@better-auth/test-utils` `testAdapter`), Auth.js (`runBasicTests`), Mastra (`stores/_test-utils`, for example `createRunFencingTests`) and Payload (one integration suite across about 16 database profiles in `test/dbAdapters.ts`) all do this. For a Postgres-only design, the equivalent is our existing integration tests on a real Postgres, run against each Host connection style (pg Pool, a Drizzle transaction).

### Which approaches keep transactions, advisory locks, SKIP LOCKED, pg_trgm and jsonb

| Approach                                                                 | Transactions                                                                   | Advisory locks                   | SKIP LOCKED                      | pg_trgm                          | jsonb                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------- | -------------------------------- | ---------------------------- |
| Generic CRUD adapter (Better Auth, Auth.js, Payload)                     | Yes, via an adapter `transaction()` callback or Payload's `req`/transaction ID | No                               | No (Payload uses CAS)            | No                               | Only as an opaque JSON value |
| Typed repository per domain, one adapter per backend (Mastra)            | Yes, inside the adapter                                                        | Yes, inside the Postgres adapter | Yes, inside the Postgres adapter | Yes, inside the Postgres adapter | Yes                          |
| Postgres only, the library owns its SQL (pg-boss, Graphile Worker, DBOS) | Yes, including the Host's transaction via BYO `executeSql` or datasource       | Yes                              | Yes                              | Yes                              | Yes                          |

---

## 1. Better Auth

**Interface: generic CRUD.** `DBAdapter` has `create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `consumeOne`, `incrementOne` and `transaction`, plus optional `createSchema` ([core adapter source](https://github.com/better-auth/better-auth/blob/main/packages/core/src/db/adapter/index.ts)).

- **Addressing.** Every call takes a `model` name and a `where: Where[]` list.
- **Operators.** `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with` and `ends_with`, with `AND`/`OR` connectors and a case-`mode` (same source).
- **Authoring.** Adapters are written with `createAdapterFactory`, which handles ID generation, JSON/date/boolean coercion, key mapping and joins ([Create a Database Adapter](https://better-auth.com/docs/guides/create-a-db-adapter)).

**Transactions and locking.**

- **Transactions.** `transaction(cb)` passes a `DBTransactionAdapter`, the same CRUD surface minus `transaction`. The config may set `transaction: false`, and "operations run sequentially" then ([guide](https://better-auth.com/docs/guides/create-a-db-adapter#transaction)). The source notes that an adapter may run the callback more than once, as on MongoDB ([source](https://github.com/better-auth/better-auth/blob/main/packages/core/src/db/adapter/index.ts)).
- **No locks, no raw SQL.** The interface has no row-lock, advisory-lock or raw-SQL method.
- **Race safety.** Concurrency safety comes from two purpose-built methods:
  - **`consumeOne`.** "Atomically deletes a single matching record and returns it, so that two concurrent requests cannot both consume the same row."
  - **`incrementOne`.** An atomic guarded update.
  - **Fallbacks.** Without native implementations, Better Auth falls back to a conditional delete, and to conditional updates "with bounded retries", which throw once retries are exhausted ([guide](https://better-auth.com/docs/guides/create-a-db-adapter#consumeone-method)).

**Migrations and optional features.**

- **Plugin schema.** A plugin passes a `schema` object, with table name → fields, an optional `modelName`, and `disableMigration` ([Plugins › Schema](https://better-auth.com/docs/concepts/plugins#schema)).
- **`generate`.** "If you're using a database adapter like Prisma or Drizzle, this command will generate the right schema for your ORM. If you're using the built-in Kysely adapter, it will generate an SQL file" ([CLI](https://better-auth.com/docs/concepts/cli#generate)).
- **`migrate`.** "This is available if you're using the built-in Kysely adapter. For other adapters, you'll need to apply the schema using your ORM's migration tool" ([CLI](https://better-auth.com/docs/concepts/cli#migrate)). Programmatic `getMigrations` likewise "only works with the built-in Kysely adapter" ([Database](https://better-auth.com/docs/concepts/database)).
- **Who owns the migrations.** Better Auth owns the _schema description_. The **Host** owns the migration files and runs them, except on Kysely, where Better Auth diffs the live DB.
- **Optional features.** Only configured plugins contribute tables, because the CLI loads the Host's config.
- **`check schema`.** It validates the live DB (Kysely) or the schema object (Drizzle and Prisma), but "Drizzle and Prisma checks do not confirm that migrations have been applied" ([CLI › Check](https://better-auth.com/docs/concepts/cli#check)).

**Testing.** `@better-auth/test-utils/adapter` exports `testAdapter` and `createTestSuite`, built on vitest. It runs the Host-supplied `runMigrations`, then the suites, then cleans every table ([guide › Test your adapter](https://better-auth.com/docs/guides/create-a-db-adapter#test-your-adapter)).

## 2. Mastra

**Interface: typed repositories per domain.**

- **Base class.** Every domain extends `StorageDomain`, which has `init()` ("should create any necessary tables/collections"), `dangerouslyClearAll()` and `prune()` ([domains/base.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/base.ts)).
- **Domain methods.** A domain such as `WorkflowsStorage` declares intent-level methods: `persistWorkflowSnapshot`, `loadWorkflowSnapshot`, `listWorkflowRuns`, `claimRunOwnership` / `renewRunOwnership` / `releaseRunOwnership`, and others ([domains/workflows/base.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/workflows/base.ts)).
- **Domain list.** The documented domains are `memory`, `workflows`, `scores`, `observability`, `agents`, `datasets` and `experiments`. The options list more ([Composite storage](https://mastra.ai/reference/storage/composite.md)).
- **Backends.** There are about 40 store packages under [`stores/`](https://github.com/mastra-ai/mastra/tree/main/stores), including pg, libsql, mysql, mongodb, dynamodb and cloudflare-d1.

**Transactions and locking.** These stay inside each adapter.

- **Capability flags.** The domain declares them: `supportsConcurrentUpdates()` (abstract) and `supportsRunFencing()` (default false). The docs say adapters returning true "must pass the run-fencing conformance suite" ([workflows/base.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/workflows/base.ts)).
- **The Postgres adapter.** **Source only**: it uses `FOR UPDATE SKIP LOCKED` in retention pruning ([stores/pg db/index.ts](https://github.com/mastra-ai/mastra/blob/main/stores/pg/src/storage/db/index.ts)), and both `pg_advisory_xact_lock(hashtext(...))` and `FOR UPDATE SKIP LOCKED` on an outbox in its knowledge domain ([stores/pg knowledge](https://github.com/mastra-ai/mastra/blob/main/stores/pg/src/storage/domains/knowledge/index.ts)).
- **Raw access.** The store exposes `store.db` for raw SQL, and "You are responsible for proper connection and transaction handling" ([PostgreSQL storage](https://mastra.ai/reference/storage/postgresql.md)).

**Migrations and optional features.**

- **Runtime DDL, no migration files.** "When you pass storage to the Mastra class, `init()` is called automatically". `disableInit`: "When true, automatic table creation/migrations are disabled", for CI/CD "where migrations are run separately" ([PostgreSQL storage](https://mastra.ai/reference/storage/postgresql.md)).
- **How the DDL is written.** **Source only**: `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. Some data migrations are too heavy for init and tell the user to run `npx mastra migrate` ([db/index.ts](https://github.com/mastra-ai/mastra/blob/main/stores/pg/src/storage/db/index.ts)).
- **Composite stores.** `MastraCompositeStore` "initializes each configured domain independently", so a domain can live on a different backend, fall back to `default`, or be set to `false`, which persists nothing ([Composite storage](https://mastra.ai/reference/storage/composite.md)).
- **Optional features.** A domain adds tables only when it is configured.

**Testing.** [`stores/_test-utils`](https://github.com/mastra-ai/mastra/tree/main/stores/_test-utils/src) holds shared per-domain suites (`createMemoryTest`, `createWorkflowsTests`, `createRunFencingTests` and more) with `TestCapabilities` flags, run against each store package.

## 3. Auth.js

**Interface: typed repository, one fixed domain.**

- **Methods.** About 20 domain methods, all optional: `createUser`, `getUserByAccount`, `linkAccount`, `createSession`, `getSessionAndUser`, `createVerificationToken`, `useVerificationToken`, authenticator methods and so on ([adapters.ts](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/adapters.ts)).
- **Partial adapters.** "You can implement only the methods you need", but official adapters "must implement all methods" ([Creating a database adapter](https://authjs.dev/guides/creating-a-database-adapter)).

**Transactions and locking.** The interface has no transaction or lock primitive (same source). Atomicity (for example, single-use tokens in `useVerificationToken`) is left to each adapter's implementation.

**Migrations and optional features.** The **Host** owns the schema.

- **pg adapter.** Its page prints the `CREATE TABLE` SQL "for the tables used by this adapter" ([pg adapter](https://authjs.dev/getting-started/adapters/pg)).
- **Drizzle adapter.** The Host writes the schema file, runs `drizzle-kit generate`, and may pass its own tables: `DrizzleAdapter(db, { usersTable, accountsTable, sessionsTable, verificationTokensTable })`. `sessionsTable` and `verificationTokensTable` are needed only for database sessions and magic links ([Drizzle adapter](https://authjs.dev/getting-started/adapters/drizzle)).
- **Optional features.** Leaving out an optional table is how an unused feature drops its table. The guidance is to "only create the database tables/columns that are actually going to be used" ([guide](https://authjs.dev/guides/creating-a-database-adapter)).

**Testing.** `runBasicTests({ adapter, db: { connect, disconnect, user, session, account, verificationToken, … }, skipTests })`. The `db` helpers read rows directly, to check the adapter's writes ([packages/utils/adapter.ts](https://github.com/nextauthjs/next-auth/blob/main/packages/utils/adapter.ts)). Official adapters must pass it ([guide](https://authjs.dev/guides/creating-a-database-adapter)).

## 4. Payload

**Interface: large generic adapter.**

- **Methods.** **Source only**: `BaseDatabaseAdapter` has about 50 members. They include `create`, `find`, `findOne`, `updateOne`, `updateMany`, `deleteMany`, `upsert`, the version and global methods, `updateJobs`, `beginTransaction` / `commitTransaction` / `rollbackTransaction`, and `migrate*` ([database/types.ts](https://github.com/payloadcms/payload/blob/main/packages/payload/src/database/types.ts)).
- **Official adapters.** MongoDB (Mongoose), Postgres (Drizzle) and SQLite (Drizzle) ([Database overview](https://payloadcms.com/docs/database/overview)).

**Transactions and locking.**

- **Transactions.** "By default, Payload will use transactions for all data changing operations". Hooks join by passing `req`. Manual `beginTransaction` returns a transaction ID. Transactions can be disabled with `transactionOptions: false` or `disableTransaction: true` ([Transactions](https://payloadcms.com/docs/database/transactions)).
- **Job claims.** **Source only**: the Drizzle `updateJobs` claims jobs with a compare-and-swap `UPDATE … WHERE processingUntil IS NULL OR processingUntil <= now`. The comment reads: "We don't need FOR UPDATE SKIP LOCKED here because of the compare-and-swap-style update" ([drizzle/updateJobs.ts](https://github.com/payloadcms/payload/blob/main/packages/drizzle/src/updateJobs.ts)).
- **Raw access.** Escape hatches exist: `payload.db` exposes the Drizzle instance, tables, relations and enums. `beforeSchemaInit`/`afterSchemaInit` hooks and `extendTable` add tables, columns and indexes "that aren't supported by Payload", but those "won't be added to the generated … Drizzle schema" ([Postgres](https://payloadcms.com/docs/database/postgres)).

**Migrations and optional features.**

- **Who writes the migrations.** The **Host's project** owns them. `migrate:create` generates SQL from the diff of the Payload config, and the files live in the Host's `./src/migrations` (`migrationDir`).
- **Dev and prod.** Dev uses Drizzle `push`. Prod can run `prodMigrations` at startup ([Migrations](https://payloadcms.com/docs/database/migrations)).
- **Optional features.** A plugin adds collections to the config, so its tables arrive through the Host's next generated migration. The migrations page does not say whether plugins ship migrations (**unverified**).

**Testing.** **Source only**: one integration suite runs across about 16 database profiles (mongodb, cosmosdb, firestore, postgres, postgres-uuid, postgres read replicas, sqlite, supabase and others) ([test/dbAdapters.ts](https://github.com/payloadcms/payload/blob/main/test/dbAdapters.ts)).

## 5. pg-boss (Postgres only)

**Interface: no storage adapter.** pg-boss owns all its SQL ([src/plans.ts](https://github.com/timgit/pg-boss/blob/main/src/plans.ts)).

- **The connection seam.** The only seam is the connection: "Passing an object named db allows you 'bring your own database connection'", where the object is "a function named `executeSql`" ([constructor](https://pgboss.io/api/constructor)).
- **Wrappers.** Ships `fromDrizzle`, `fromKysely`, `fromKnex`, `fromPrisma`, `bun` and `pglite` wrappers ([src/adapters](https://github.com/timgit/pg-boss/tree/main/src/adapters), [adapters doc](https://pgboss.io/api/adapters)).
- **Enqueue in the Host's transaction.** For example `boss.send('q', data, { db: fromDrizzle(tx, sql) })` inside `db.transaction` ([drizzle.ts](https://github.com/timgit/pg-boss/blob/main/src/adapters/drizzle.ts)).

**Transactions and locking.** **Source only**: fetch uses `FOR UPDATE OF j SKIP LOCKED`, with a `noSkipLocked` mode for CockroachDB. Schema changes are wrapped in `pg_advisory_xact_lock` via `locked()` ([plans.ts](https://github.com/timgit/pg-boss/blob/main/src/plans.ts)).

**Migrations.**

- **Ownership and versioning.** The library owns them, versioned in its own schema (default `pgboss`) with a `version` table (source).
- **On start.** `start()` migrates unless `migrate: false`, in which case pending migrations make `start()` throw. `createSchema: false` skips `CREATE SCHEMA` ([constructor](https://pgboss.io/api/constructor)).
- **CLI.** `migrate` (with `--dry-run`), `create`, `version`, and `plans`, which "prints SQL to stdout without touching the database … useful for review, manual execution, or checking into version control" ([CLI](https://pgboss.io/cli)).
- **Optional features.** Partitioned queues get per-queue tables at runtime (source).

**Testing.** **Source only**: the test suite runs against real Postgres, with configs for Citus, CockroachDB and YugabyteDB, plus `adapterTest.ts` for the BYO-connection wrappers ([test/](https://github.com/timgit/pg-boss/tree/main/test)).

## 6. Graphile Worker (Postgres only)

**Interface: no storage adapter.**

- **Schema.** The library owns schema `graphile_worker` (configurable) ([Schema](https://worker.graphile.org/docs/schema)).
- **Public surface.** The public surface is SQL: `graphile_worker.add_job()`, admin functions and the `jobs` view. "Database tables are not a public interface!", and the `_private_*` tables "may change in a minor version" ([Schema](https://worker.graphile.org/docs/schema)).
- **Enqueueing in the Host's transaction.** Because `add_job` is a SQL function, a Host can call it "from a trigger or function, or by calling SQL from your application code" ([add_job](https://worker.graphile.org/docs/sql-add-job)). That makes enqueueing part of the Host's own transaction for free (inferred; the page does not say "same transaction").

**Transactions and locking.** **Source only**: job fetching uses `skip locked` ([sql/](https://github.com/graphile/worker/tree/main/sql)).

**Migrations.**

- **Source.** Numbered SQL files (`000001.sql` … `000020.sql`) are compiled into the package and applied in a transaction each ([src/migrate.ts](https://github.com/graphile/worker/blob/main/src/migrate.ts)).
- **Concurrency.** **Source only**: concurrent workers race, and the loser treats the unique-violation on `migrations` as "Some other worker has performed migration … continuing" rather than taking an advisory lock.
- **Breaking migrations.** A `breaking` column marks them. An older worker refuses to run against a schema with a newer breaking migration, because "It would be unsafe to continue" (same source).

## 7. DBOS Transact (Postgres only)

**Interface: no storage adapter for its own state.**

- **System database.** DBOS owns a system database ("If [it] does not exist, DBOS will attempt to create it"), which defaults to `<app>_dbos_sys`, with schema `systemDatabaseSchemaName` defaulting to `dbos`. It accepts a Host `systemDatabasePool`, which "DBOS.shutdown does not close" ([Configuration](https://docs.dbos.dev/typescript/reference/configuration)).
- **Tables.** `workflow_status`, `operation_outputs`, `notifications`, `queues`, `dbos_migrations` and others ([System tables](https://docs.dbos.dev/explanations/system-tables)).

**The Host-transaction seam: datasources.**

- **Packages.** Seven datasource packages: Knex, Kysely, Drizzle, TypeORM, Prisma, node-postgres and Postgres.js.
- **What a transaction step does.** It runs the Host's code with "atomically committing both user-defined changes and a DBOS checkpoint", which needs a `dbos.transaction_completion` table in the _app_ database ([Transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)).
- **The handler interface.** It is small: `initialize`, `destroy`, `deleteCheckpoints?` and `invokeTransactionFunction` ([src/datasource.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/main/src/datasource.ts)).

**Transactions and locking.** **Source only**: queue dequeue uses `SKIP LOCKED` in [src/system_database.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/main/src/system_database.ts).

**Migrations.**

- **System database.** It is created and migrated on launch by default. Turn that off "for a process that must not alter the schema", then migrate out of band with `npx dbos schema` or `DBOS.migrate`. With migrations off, "Launch then verifies the schema instead of changing it", and a missing or outdated schema "fails launch with a `DBOSInitializationError`" ([Configuration](https://docs.dbos.dev/typescript/reference/configuration)).
- **Datasource table.** It is created at launch, or by calling `initializeDBOSSchema` from the Host's own (for example Knex) migration with `applicationRole` grants, then constructing the datasource with `runMigrations: false` ([Transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)).
- **Journal.** The version is tracked in `dbos_migrations` ([migration_runner.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/main/src/sysdb_migrations/migration_runner.ts)).

---

## Summary table

| Library         | Interface                                | Tx / locks through the seam                                      | Who owns migrations                                            | Optional feature → tables                | Adapter tests                            |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Better Auth     | Generic CRUD, about 11 methods           | `transaction(cb)`; no locks, `consumeOne`/`incrementOne` instead | Host (Drizzle/Prisma); library only on Kysely                  | Plugin `schema` → CLI `generate`         | `@better-auth/test-utils` `testAdapter`  |
| Mastra          | Typed repository per domain              | Inside each adapter (pg uses SKIP LOCKED and advisory locks)     | Library, runtime `init()` DDL; `disableInit`                   | Configured domains only                  | `stores/_test-utils` per-domain suites   |
| Auth.js         | Typed repository, about 20 methods       | None                                                             | Host                                                           | Omit the table                           | `runBasicTests`                          |
| Payload         | Generic, about 50 methods                | Transactions per request; CAS, not SKIP LOCKED                   | Host project (`migrate:create`)                                | Plugin collections → next Host migration | One suite × about 16 DB profiles         |
| pg-boss         | None (owns SQL); BYO `executeSql`        | Full: SKIP LOCKED, advisory locks, Host tx                       | Library; on start, off, or exported SQL                        | Runtime partitions                       | Real PG + Citus, CockroachDB, YugabyteDB |
| Graphile Worker | None (owns SQL); SQL API                 | Full                                                             | Library; numbered SQL, `breaking` flag                         | n/a                                      | Real PG                                  |
| DBOS            | None (owns SQL); datasources for Host tx | Full                                                             | Library; on launch, or `DBOS.migrate` / `initializeDBOSSchema` | n/a                                      | Real PG                                  |
