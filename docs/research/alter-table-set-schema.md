# Research: What `ALTER TABLE ... SET SCHEMA` moves

Ticket: [#430 What ALTER TABLE SET SCHEMA moves](https://github.com/Daanish2003/ai-chat/issues/430) (child of map [#411](https://github.com/Daanish2003/ai-chat/issues/411)).
Researched: 2026-10-16, from the PostgreSQL 18 docs, the PostgreSQL `REL_18_STABLE` source, the pgvector and `pg_trgm` control files, and the installed drizzle-orm migrator.

## Question

[ADR 0019](../adr/0019-a-family-of-copied-sdks.md) moves tables out of the `chat` schema into one schema per SDK, in place. What does `ALTER TABLE ... SET SCHEMA` take with it, and what has to be done by hand? Specifically: indexes, constraints, sequences or identity columns, triggers, and the trigram and pgvector indexes. Enum types. Whether foreign keys keep working across schemas, and how to drop one in the same migration. Locking, and whether it all runs in one transaction. How `pg_trgm` and `vector`, installed in `public`, and their operator classes are referenced after the move.

Postgres version: **18**. `docker-compose.yml` and both `postgres` services in `.github/workflows/ci.yml` use `pgvector/pgvector:0.8.7-pg18-trixie`.

## Answer

- **Moved with the table**: the table's indexes (including the GIN trigram and HNSW indexes), its constraints (primary key, unique, check, foreign key), its owned sequences (serial and identity), and its row type with that row type's array type. There is nothing else to do for these.
- **Not moved**: enum types. Each one needs its own `ALTER TYPE ... SET SCHEMA`, which also moves the enum's array type. Columns keep working whether or not the enum moves, because a column stores its type's OID, not its name.
- **Foreign keys keep working across schemas.** A constraint stores the referenced table's OID, so moving either end changes nothing. To drop one, use `ALTER TABLE ... DROP CONSTRAINT [IF EXISTS] name`. It takes `ACCESS EXCLUSIVE` on **both** tables.
- **Locks and transactions**: `SET SCHEMA` takes `ACCESS EXCLUSIVE` on the table (and on its owned sequences) and holds it until commit. It's a catalog-only change with no table rewrite. The drizzle migrator `chat.migrate()` uses runs **every pending migration in one transaction**, so the moves commit or roll back together.
- **Extensions**: nothing to do. Index operator classes, column types and default or generated expressions are stored as OIDs, so `public.gin_trgm_ops`, `vector_cosine_ops` and `vector(1536)` keep pointing at the objects in `public`. Only SQL text written later (new DDL, runtime queries) resolves names, and it does so through `search_path` or explicit qualification, exactly as it does today.

Not verified on a live database: nothing was listening on port 5435 and Docker wasn't running, so every claim here comes from the docs and the source, not from running it.

## What moves with the table

The docs say: "This form moves the table into another schema. Associated indexes, constraints, and sequences owned by table columns are moved as well." ([ALTER TABLE, PG 18](https://www.postgresql.org/docs/18/sql-altertable.html))

The source shows the full list. `AlterTableNamespaceInternal` ([tablecmds.c, REL_18_STABLE](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/tablecmds.c)) does, in order:

1. `AlterRelationNamespaceInternal`: rewrites the table's `pg_class.relnamespace` and its `pg_depend` link to the schema. It errors with `relation "..." already exists in schema "..."` if the target schema already has a relation of that name.
2. `AlterTypeNamespaceInternal(rel->rd_rel->reltype, ...)`: moves the table's row type, which then recurses into the row type's array type ([typecmds.c](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/typecmds.c)).
3. `AlterIndexNamespaces`: moves every index in `RelationGetIndexList(rel)`. That covers all of them, whatever the access method, so the GIN trigram and HNSW indexes move too.
4. `AlterSeqNamespaces`: moves each sequence with an `AUTO` or `INTERNAL` dependency on one of the table's columns (the comment says: "identity and SERIAL-column sequences"). Moving an owned sequence on its own is refused: "cannot move an owned sequence into another schema".
5. `AlterConstraintNamespaces`: moves the table's `pg_constraint` rows (`connamespace`).

What isn't on that list, and why it doesn't matter here:

- **Triggers** have no schema. A trigger belongs to its table (`pg_trigger.tgrelid`). The internal triggers behind a foreign key go with their table. A user trigger's _function_ is a separate object in its own schema and does **not** move. None of the migrations create triggers or functions.
- **TOAST tables** live in `pg_toast` and aren't renamed.
- **Sequences**: there are none to move. Every key in the migrations is `uuid` or `text`, with no `serial`, `identity` or `nextval`.

### The indexes affected

From `packages/chat-sdk/core/server/migrations/*/migration.sql`:

| Table                      | Indexes besides the primary key                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`             | `conversation_user_id_last_message_at_idx`, `conversation_title_trgm_idx` (GIN, `public.gin_trgm_ops`), partial indexes `_unprojected_`, `_project_id_`, `_pinned_`, `_archived_` |
| `message`                  | `message_conversation_id_parent_id_idx`, `message_search_text_trgm_idx` (GIN, `public.gin_trgm_ops`), `message_search_text_fts_idx` (GIN on `to_tsvector('simple', search_text)`) |
| `attachment`               | `attachment_user_id_created_at_idx`                                                                                                                                               |
| `message_attachment`       | `message_attachment_attachment_id_idx`                                                                                                                                            |
| `usage`                    | `usage_user_id_created_at_idx`                                                                                                                                                    |
| `blob`, `user_credentials` | primary key only                                                                                                                                                                  |
| `job`                      | `job_idempotency_key_active_idx` (unique, partial), `job_claim_idx`                                                                                                               |
| `knowledge_chunk`          | `knowledge_chunk_embedding_idx` (HNSW, `vector_cosine_ops`), `knowledge_chunk_tsv_idx` (GIN on the generated `tsv` column)                                                        |
| `knowledge_file`           | `knowledge_file_project_id_idx`                                                                                                                                                   |
| `memory`                   | `memory_embedding_hnsw_idx` (HNSW, `vector_cosine_ops`), `memory_conversation_id_idx`                                                                                             |

All of these move with their table. Index names are relation names in the index's schema, so the duplicate-name check in step 1 applies to them as well.

## Enum types: by hand

`ALTER TABLE ... SET SCHEMA` moves only the table's own row type (step 2 above). An enum the table's columns use is a separate type. `ALTER TYPE name SET SCHEMA new_schema`: "moves the type into another schema". It needs ownership of the type and `CREATE` on the new schema ([ALTER TYPE, PG 18](https://www.postgresql.org/docs/18/sql-altertype.html)).

- It moves the type's array type too: `AlterTypeNamespaceInternal` ends with "Recursively alter the associated array type, if any". Moving the array type directly is refused ("You can alter type %s, which will alter the array type as well.") ([typecmds.c](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/typecmds.c)).
- Running it on a table's row type is refused with the hint `Use ALTER TABLE instead.`
- It errors if the target schema already has a type of that name.
- Columns don't care where the enum lives. `pg_attribute.atttypid` holds the type's OID, and defaults such as `DEFAULT 'processing'::"chat"."knowledge_file_status"` are stored in `pg_attrdef.adbin` as an expression tree, "in `nodeToString()` representation" ([pg_attrdef](https://www.postgresql.org/docs/18/catalog-pg-attrdef.html)), which holds OIDs, not names. A table in one schema can use an enum in another.

The enums and the columns that use them:

| Enum (in `chat`)                                                           | Used by                   |
| -------------------------------------------------------------------------- | ------------------------- |
| `message_role`, `message_status`, `message_error_reason`, `message_rating` | `message`                 |
| `reasoning_effort`                                                         | `conversation`, `message` |
| `usage_kind`                                                               | `usage`                   |
| `artifact_kind`                                                            | `artifact`                |
| `job_status`                                                               | `job`                     |
| `knowledge_file_status`                                                    | `knowledge_file`          |
| `memory_origin`                                                            | `memory`                  |

An enum such as `reasoning_effort`, used by two tables, can only be in one schema at a time.

Related: "If `ALTER TYPE ... ADD VALUE` ... is executed inside a transaction block, the new value cannot be used until after the transaction has been committed." ([ALTER TYPE](https://www.postgresql.org/docs/18/sql-altertype.html)) This matters only if a migration both adds an enum value and uses it.

## Foreign keys

- A foreign key stores OIDs. `pg_constraint.conrelid` is "The table this constraint is on" and `confrelid` is "If a foreign key, the referenced table". Both are `oid` columns referencing `pg_class.oid` ([pg_constraint](https://www.postgresql.org/docs/18/catalog-pg-constraint.html)). Moving either table leaves the constraint working, with no extra step.
- The constraint moves with the table it's **on** (`AlterConstraintNamespaces(RelationGetRelid(rel), ...)`), not with the table it references.
- To drop one: `ALTER TABLE t DROP CONSTRAINT [ IF EXISTS ] name`. "This form drops the specified constraint on a table, along with any index underlying the constraint. If `IF EXISTS` is specified and the constraint does not exist, no error is thrown." ([ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html)) It works before or after the move, in the same transaction. After the move, name the table by its new schema.
- Locks for the drop: `ACCESS EXCLUSIVE` on the table, and for a foreign key that isn't self-referencing, `ACCESS EXCLUSIVE` on the **referenced** table as well. The source says: `frel = table_open(con->confrelid, AccessExclusiveLock)`, "Must match lock taken by RemoveTriggerById" (`dropconstraint_internal`, [tablecmds.c](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/tablecmds.c)).

ADR 0019 says references across SDKs are plain string ids with no foreign keys. Which of the existing foreign keys end up crossing schemas depends on how the tables are split, which isn't decided here. Today's foreign keys among the tables mentioned in the brief and the ones ADR 0019 names:

- `message.conversation_id → conversation`, `message.parent_id → message`, `message.context_start_id → message`, `conversation.active_leaf_id → message`, `conversation.project_id → project`
- `message_attachment.message_id → message`, `message_attachment.attachment_id → attachment`
- `memory.conversation_id → conversation`, `memory.replaced_by_id → memory`
- `knowledge_chunk.file_id → knowledge_file`, `knowledge_file.project_id → project`
- `artifact.conversation_id → conversation`, `artifact_version.* → artifact, message`, `generated_image.message_id → message`, `shared_link.* → conversation, message`
- `blob`, `user_credentials`, `usage` and `job` have no foreign keys.

## Locking and transactions

- `ALTER TABLE`: "An `ACCESS EXCLUSIVE` lock is acquired unless explicitly noted." `SET SCHEMA` has no such note ([ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html)). In the source, `AlterTableNamespace` resolves the table with `AccessExclusiveLock` and closes it with `NoLock` ("keep lock until commit"). `AlterSeqNamespaces` opens each owned sequence with `AccessExclusiveLock` as well.
- It only updates catalog rows (`pg_class`, `pg_type`, `pg_constraint`, `pg_depend`). There's no rewrite or data copy, so the cost is waiting for the lock. Under `ACCESS EXCLUSIVE`, readers and writers of that table block until the transaction commits.
- `SET SCHEMA` can't be combined with other subcommands: "All the forms of `ALTER TABLE` that act on a single table, except `RENAME`, `SET SCHEMA`, `ATTACH PARTITION`, and `DETACH PARTITION` can be combined into a list". Each table needs its own statement.
- `ALTER TYPE ... SET SCHEMA` goes through `AlterTypeNamespace` (dispatched from `ExecAlterObjectSchemaStmt`, [alter.c](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/alter.c)). That path opens only `pg_type` (and, for composites, `pg_class`) with `RowExclusiveLock`. It takes no lock on the tables whose columns use the enum. The docs don't mention a lock level.
- Privileges: you must own the table (or type) and have `CREATE` on the target schema.
- One transaction: the installed drizzle-orm (`1.0.0-rc.4`, `pg-core/async/session.js`) runs `db.transaction(...)` around **all** pending migrations. It runs each statement (split on `--> statement-breakpoint`) and the insert into the journal. A failure rolls back every pending migration, including the moves. `chat.migrate()` also holds a session advisory lock around the run (`packages/chat-sdk/core/server/migrate.ts`). Not tested here: a rollback restoring the old schema. It follows from these being ordinary catalog updates inside the transaction.
- Out of scope but nearby: drizzle's journal is `chat.__migrations` (`migrationsSchema: "chat"` in `migrate.ts`). The TypeScript schema (`chatSchema.enum(...)`, `pgSchema("chat")`) produces schema-qualified SQL, so runtime queries name `"chat"."table"` until the TypeScript schema changes too.

## Extensions in `public` and operator classes

- `chat.migrate()` runs `create extension if not exists pg_trgm` and `create extension if not exists vector` with no `SCHEMA`, so their objects go into "the current default object creation schema" ([CREATE EXTENSION](https://www.postgresql.org/docs/18/sql-createextension.html)), normally `public`. "The extension itself is not considered to be within any schema ... But objects belonging to the extension can be within schemas."
- Existing objects refer to extension objects by OID:
  - Index operator classes: `pg_index.indclass` holds, "For each column in the index key ..., the OID of the operator class to use" ([pg_index](https://www.postgresql.org/docs/18/catalog-pg-index.html)). Index expressions and partial-index predicates are stored in `nodeToString()` form (`indexprs`, `indpred`).
  - Column types (`vector(1536)`): `pg_attribute.atttypid` holds an OID.
  - The generated `tsv` column (`to_tsvector('english', text)`) and the `to_tsvector('simple', ...)` index expression store the text-search config as an OID in the expression tree.
- So after the move, `conversation_title_trgm_idx` still uses `public.gin_trgm_ops`, the HNSW indexes still use `public.vector_cosine_ops`, and `embedding` is still `public.vector`. Nothing is looked up by name again, and the migrate role's `search_path` doesn't matter for objects that already exist.
- Name lookup still matters for **SQL text written later**: new migrations that write unqualified `vector(1536)` or `vector_cosine_ops`, and runtime queries that use `<=>`, `similarity()` or `%`. These resolve through `search_path` or explicit qualification, exactly as today. The move changes nothing here. The existing migrations already qualify the trigram opclass as `public.gin_trgm_ops`. The HNSW opclass and the `vector` type are unqualified.
- Both extensions are relocatable, if they ever have to move: `pg_trgm.control` has `relocatable = true` ([source](https://github.com/postgres/postgres/blob/REL_18_STABLE/contrib/pg_trgm/pg_trgm.control)), and so does `vector.control` ([source](https://github.com/pgvector/pgvector/blob/master/vector.control); see also [pgvector-availability.md](./pgvector-availability.md)). The table move doesn't need that.

## Not verified

- No live run. Nothing was listening on port 5435, so these were not observed against Postgres 18: the moves, the duplicate-name errors, the lock waits, or a rollback restoring the old schema.
- The lock taken by `ALTER TYPE ... SET SCHEMA` is read from the source path described above. The docs don't state it.
- How `pg_get_expr` / `\d` _display_ a default or index after the move (for example whether they print `agent.knowledge_file_status` or the bare name, depending on `search_path`) wasn't checked. It affects only display and dumps, not behaviour.
