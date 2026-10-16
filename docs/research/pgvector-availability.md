# Research: Making pgvector available to the Chat SDK

Ticket: [#199 Making pgvector available to the Chat SDK](https://github.com/Daanish2003/ai-chat/issues/199) (child of map [#197](https://github.com/Daanish2003/ai-chat/issues/197)).
Researched: 2026-10-12, from Postgres and pgvector source, Docker Hub, and Neon and Supabase docs and source.

## Question

The Chat SDK runs its own migrations with `chat.migrate()` in its own Postgres schema ([ADR 0005](../adr/0005-copied-stack-agnostic-chat-sdk.md)). Can a migration run `CREATE EXTENSION IF NOT EXISTS vector` as a non-superuser on Neon and Supabase, and which pgvector versions do they ship (HNSW, `halfvec`)? Which Docker image should replace `postgres:18` locally and in CI? What does a Host see if the extension can't be created, and how do other copy-in libraries handle that?

## Answer

- **Yes on both, but not because the extension is "trusted".** pgvector is **not** marked `trusted`, so plain Postgres needs a superuser to create it. Neon and Supabase each let their default (non-superuser) database user run `CREATE EXTENSION vector` through a provider allow-list. A self-hosted Host whose migrate role isn't a superuser (or the database owner on a provider) will get `permission denied`.
- **Versions**: HNSW needs pgvector ≥ 0.5.0 and `halfvec` ≥ 0.7.0. Neon ships 0.8.0 (PG 14–17) and 0.8.6 (PG 18); Supabase builds up to 0.8.2 (PG 15, 17). All documented versions have both HNSW and `halfvec`.
- **Docker**: replace `postgres:18` with `pgvector/pgvector:0.8.7-pg18-trixie` (or the floating `pg18-trixie`), in `docker-compose.yml` and both `postgres` services in `.github/workflows/ci.yml`. Use the **`-trixie`** tag: `postgres:18` is Trixie, while pgvector's bare `pg18` tag is Bookworm.
- **Failure**: Postgres raises `permission denied to create extension "vector"` with hint `Must be superuser to create this extension.`, or `extension "vector" is not available` if the server lacks the files. `chat.migrate()` should catch it and rethrow with a Host-facing message, exactly as it already does for `pg_trgm`. Sim fails hard; Mastra and LangChain.js try, then fall back or let the Host skip the step.

## Why `pg_trgm` works anywhere and `vector` doesn't

- `chat.migrate()` already runs `create extension if not exists pg_trgm` before the Drizzle migrations, and wraps a failure in "chat.migrate() needs the pg_trgm extension… run migrate as a role allowed to create extensions" (`packages/bot-sdk/core/server/migrate.ts`, `createTrigramExtension`).
- Postgres: "Loading an extension ordinarily requires the same privileges that would be required to create its component objects. For many extensions this means superuser privileges are needed. However, if the extension is marked _trusted_ in its control file, then it can be installed by any user who has `CREATE` privilege on the current database." ([CREATE EXTENSION, PG 18](https://www.postgresql.org/docs/18/sql-createextension.html))
- `pg_trgm.control` has `trusted = true` ([source, REL_18_STABLE](https://github.com/postgres/postgres/blob/REL_18_STABLE/contrib/pg_trgm/pg_trgm.control)).
- `vector.control` has only `comment`, `default_version = '0.8.7'`, `module_pathname` and `relocatable = true`. There is **no `trusted` line** ([source](https://github.com/pgvector/pgvector/blob/master/vector.control)). On vanilla Postgres, only a superuser can create it.
- Because it's `relocatable` and created without `SCHEMA`, it lands in the first schema on the role's `search_path` (usually `public`) ([CREATE EXTENSION](https://www.postgresql.org/docs/18/sql-createextension.html)). Extension names are unique per database, so `IF NOT EXISTS` is a no-op if the Host already installed `vector` in another schema (for example Supabase's `extensions`). The SDK's DDL must then resolve the `vector` type through `search_path` or schema-qualify it. **Not verified** what `search_path` the migrate role has on each provider.

## Providers

### Neon

- Version table: "pgvector | 0.8.0 | 0.8.0 | 0.8.0 | 0.8.0 | 0.8.6" for PG 14, 15, 16, 17, 18, "Install with `CREATE EXTENSION vector;`" ([extensions](https://neon.com/docs/extensions/pg-extensions)).
- "The extension is installed per database, not per project." HNSW and `halfvec` (up to 4,000 dimensions for HNSW) are documented ([pgvector](https://neon.com/docs/extensions/pgvector)).
- Roles: "Roles created in the Neon Console, CLI, or API, including the role created with a Neon project, are granted membership" in `neon_superuser`. Roles created with SQL are not. You "can't connect using the Postgres `superuser` account" ([roles](https://neon.com/docs/manage/roles)). The roles page doesn't list `CREATE EXTENSION` among `neon_superuser`'s rights, but the extensions page tells that role to run it. A role made with SQL may fail.

### Supabase

- Enable from the dashboard or with `create extension vector with schema extensions;` ([pgvector](https://supabase.com/docs/guides/database/extensions/pgvector)). "Most extensions are installed under the `extensions` schema" ([extensions](https://supabase.com/docs/guides/database/extensions)).
- The `postgres` role is not a superuser ("Superuser access is not given…") ([roles](https://supabase.com/docs/guides/database/postgres/roles-superuser)). Extensions work through `supautils.privileged_extensions`: listed extensions are created "as if by the superuser" ([supautils README](https://github.com/supabase/supautils#privileged-extensions)). Supabase's config lists `vector` there, with `supautils.privileged_extensions_superuser = 'supabase_admin'` ([supautils.conf.j2](https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2)).
- Versions built: 0.4.0 to 0.8.2. Versions from 0.5.1 on are built for PG 15 and 17 only, with no PG 18 entry ([nix/ext/versions.json](https://github.com/supabase/postgres/blob/develop/nix/ext/versions.json)). Which version a given project has depends on its image. Check with `pg_available_extensions`.
- A Supabase Host will usually already have `vector` in `extensions`, so the SDK's own `IF NOT EXISTS` won't move it (see above).

## Feature versions

- HNSW: "Added HNSW index type" in 0.5.0 (2023-08-28). `halfvec`: "Added `halfvec` type" in 0.7.0 (2024-04-29). Postgres 18 support arrived in 0.8.1 (rc1), with PG 18 fixes in 0.8.2 and 0.8.3. The latest release is 0.8.7 (2026-10-01) ([CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md)).
- So a migration can safely use `halfvec` and HNSW on every provider above. If the SDK wants a floor, `SELECT extversion FROM pg_extension WHERE extname = 'vector'` ≥ 0.7.0 is the one to check.

## Docker image for local and CI

- pgvector's README: `docker pull pgvector/pgvector:pg18-trixie`. "This adds pgvector to the Postgres image… run it the same way." The supported tags include `pg18-trixie`/`0.8.7-pg18-trixie` and `pg18-bookworm`/`0.8.7-pg18-bookworm`/`pg18`/`0.8.7-pg18` ([README, Docker](https://github.com/pgvector/pgvector#docker)). Docker Hub has `0.8.7-pg18-trixie` and `pg18-trixie`, both updated 2026-10-01 ([tags API](https://hub.docker.com/v2/repositories/pgvector/pgvector/tags?name=pg18)).
- The image is `FROM postgres:$PG_MAJOR-$DEBIAN_CODENAME` with pgvector built in ([Dockerfile](https://github.com/pgvector/pgvector/blob/master/Dockerfile)). Env vars, the healthcheck and the data path work unchanged.
- Official `postgres:18` = `18.6`, `18-trixie`. `18-bookworm` is a separate tag ([official-images library/postgres](https://github.com/docker-library/official-images/blob/master/library/postgres)). pgvector's bare `pg18` is **Bookworm**. Using `pg18-trixie` keeps the same Debian (and glibc collation) as the existing `ai-chat_postgres_data` volume. Switching distro on an existing volume risks collation-version warnings. This is an inference from Postgres's collation versioning and was not tested.
- Places to change (not changed here): `docker-compose.yml` `postgres.image`, and `.github/workflows/ci.yml` lines 20 and 90 (`image: postgres:18`). Pinning `0.8.7-pg18-trixie` is reproducible, while `pg18-trixie` floats with pgvector releases.
- In the image, the `postgres` user is a superuser, so `CREATE EXTENSION vector` works locally and in CI with no extra setup.

## What a Host sees on failure

From Postgres 18's `extension.c` ([source](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/extension.c)):

- Role not allowed: `ERROR: permission denied to create extension "vector"`, `HINT: Must be superuser to create this extension.` (because `vector` isn't trusted).
- Files not installed (for example plain `postgres:18`): `ERROR: extension "vector" is not available`, `HINT: The extension must first be installed on the system where PostgreSQL is running.`

If the extension isn't created, every later `vector(...)`/`halfvec(...)` column or HNSW index in a Drizzle migration fails with `type "vector" does not exist`. `chat.migrate()` stops. The existing `createTrigramExtension` wrapper is the pattern to copy. Its message would add "install pgvector, or have a superuser run `CREATE EXTENSION vector` once, then rerun migrate". Pre-creating it works because `IF NOT EXISTS` then succeeds for any role.

## How other libraries handle it

- **Sim Studio** (the Knowledge source we port, ADR 0014): a plain migration line, `CREATE EXTENSION IF NOT EXISTS vector;`, with no fallback ([0039_tranquil_speed.sql](https://github.com/simstudioai/sim/blob/main/packages/db/migrations/0039_tranquil_speed.sql)).
- **Mastra `PgVector`**: it tries `CREATE EXTENSION IF NOT EXISTS vector SCHEMA <custom>`, then without a schema. On failure it logs "Could not install vector extension. This requires superuser privileges. If the extension is already installed, you can ignore this warning.", then detects whether `vector` exists in any schema and uses that schema ([stores/pg/src/vector/index.ts](https://github.com/mastra-ai/mastra/blob/main/stores/pg/src/vector/index.ts)).
- **LangChain.js `PGVectorStore`**: it runs `CREATE EXTENSION IF NOT EXISTS vector` (or `WITH SCHEMA "<extensionSchemaName>"`) and schema-qualifies the column type with that schema. `skipInitializationCheck` lets the Host skip it entirely ([vectorstores.ts](https://github.com/langchain-ai/langchainjs/blob/main/libs/providers/langchain-pgvector/src/vectorstores.ts)).

## Implications for the specs

- `chat.migrate()` can create `vector` itself, next to `pg_trgm`, with a wrapped error. That works on Neon (Console/API roles), Supabase, and in Docker with the pgvector image. The SDK README should say "pgvector ≥ 0.7.0 required. If your migrate role can't create it, run `CREATE EXTENSION vector` once as a superuser."
- Decide (human, schema) whether to accept `vector` in any schema (Supabase's `extensions`) by detecting `pg_extension.extnamespace` and schema-qualifying the type, as Mastra and LangChain.js do, or to rely on `search_path`.
- Switching the image in compose and CI is infrastructure (AGENTS.md §6). It should be a ticket, not done here.

## Not verified

- The exact mechanism by which Neon lets a non-superuser create `vector`, and whether a SQL-created Neon role can.
- Default `search_path` of the migrate role on each provider (matters if `vector` lives outside `public`).
- Supabase PG 18 availability (no PG 18 build in `versions.json` at the time of reading).
