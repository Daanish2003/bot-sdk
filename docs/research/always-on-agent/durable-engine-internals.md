# How Postgres-native durable execution engines work inside

Research for issue #408 (child of the map #383). Researched on 2026-10-16.

**Question.** How do the Postgres-native, TypeScript-friendly durable execution engines work inside? The owner's direction on #391 is an in-house engine in plain TypeScript, with checkpointed steps in Postgres, built by extending today's runner ([ADR 0011](../../adr/0011-background-jobs-through-durable-runner.md)). This file collects the patterns to copy. For each engine it covers: schema, atomic step recording and delivery guarantee, crash recovery, step identity across deploys, durable sleep, messages in, cancellation, per-key concurrency, cron, children, LISTEN/NOTIFY vs polling, and crash-safety tests.

**Facts only.** This file doesn't design anything; the design ticket (#391) will. The engine-level comparison (licences, infra, fit) is in [durable-workflow-engine.md](https://github.com/Daanish2003/ai-chat/blob/research/durable-workflow-engine/docs/research/always-on-agent/durable-workflow-engine.md) (#386).

**Method.** The source was read at pinned commits through `gh api` and raw.githubusercontent.com. Every link points at a pinned SHA. Statements marked _(inference)_ are mine. Anything not confirmed is listed under **Unverified** at the end of each section.

| Engine                                    | Repo @ SHA                                                                                                                                               | Licence       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| DBOS Transact (TS)                        | [dbos-inc/dbos-transact-ts @ 8643d38](https://github.com/dbos-inc/dbos-transact-ts/tree/8643d389db64351f2acfce45e96e9747b4be8465)                        | MIT           |
| Absurd                                    | [earendil-works/absurd @ 5b97022](https://github.com/earendil-works/absurd/tree/5b97022ac6d1523cda92470db3b6731909cae571)                                | Apache-2.0    |
| Workflow SDK + `@workflow/world-postgres` | [vercel/workflow @ 7882c81](https://github.com/vercel/workflow/tree/7882c81480b99241090f5c316250c8203c1c2ba1) (core 5.2.2, world-postgres 5.0.4)         | Apache-2.0    |
| graphile-worker                           | [graphile/worker @ 4cda192](https://github.com/graphile/worker/tree/4cda192c5df254392a1dff350e5d73f7d2c18a85) (0.18.0; world-postgres pins 0.16.6)       | MIT           |
| pgflow                                    | [pgflow-dev/pgflow @ 9160db6](https://github.com/pgflow-dev/pgflow/tree/9160db62009f9535264824a7e76593c2e09b1769)                                        | Apache-2.0    |
| OpenWorkflow                              | [openworkflowdev/openworkflow @ 258bae9](https://github.com/openworkflowdev/openworkflow/tree/258bae924d7211a2383762fd8b03dff42b872f83)                  | (not checked) |
| pg-boss                                   | [timgit/pg-boss @ d440085](https://github.com/timgit/pg-boss/tree/d4400859eed280b58c346f5289a0312913d558bd)                                              | (not checked) |
| Hatchet (Go engine)                       | [hatchet-dev/hatchet @ c205f59](https://github.com/hatchet-dev/hatchet/tree/c205f596ec45936e11044f48e8ac61cc4cdc3f6d)                                    | MIT           |
| In-house runner                           | [Daanish2003/ai-chat @ 5dea823](https://github.com/Daanish2003/ai-chat/tree/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs) | ours          |

OpenWorkflow, pg-boss and Hatchet were added because they each show one pattern clearly. OpenWorkflow is a small TypeScript engine with real step checkpoints. pg-boss and Hatchet show attempt fencing and per-key concurrency.

---

## Pattern-by-pattern comparison

| Pattern                      | DBOS                                                                                                                                                   | Absurd                                                                                                                     | Workflow SDK (Postgres World)                                                    | pgflow                                                                                        | OpenWorkflow                                                                           | In-house runner today                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Step record**              | Row per step in `operation_outputs`, PK `(workflow_uuid, function_id)`                                                                                 | Row per checkpoint in `c_<queue>`, PK `(task_id, checkpoint_name)`                                                         | Append-only event log `workflow_events` plus a materialised `workflow_steps` row | `step_states` + `step_tasks` rows of a declared DAG                                           | `step_attempts` rows                                                                   | None: one `chat.job` row per job                                       |
| **Write atomicity**          | Insert after the step, behind an owner check (`owner_xid`). DB transactions record in the **same** transaction as the user's write                     | Upsert after the step, which also extends the lease. Refused once cancelled                                                | Step update + event insert in one transaction, fenced by a per-run sequence row  | One SQL function updates the task, step, DAG counters and archives the queue message          | Locks the owned run row, then updates the attempt                                      | `ownAttempt` guard: `id`, `status = running` and `attempts` must match |
| **Side effects**             | At-least-once for plain steps. Exactly-once only for transactions in the same Postgres                                                                 | At-least-once ("close to exactly once")                                                                                    | At-least-once (stated in HOW_IT_WORKS)                                           | At-least-once (stated in docs)                                                                | At-least-once                                                                          | At-least-once (the whole job reruns)                                   |
| **Crash recovery**           | No lease or heartbeat. A process re-enqueues **its own** `executor_id`'s pending work at launch. Other executors' work needs Conductor (closed source) | Lease (`claim_expires_at`). Any worker's `claim_task` fails expired runs first. The worker kills itself at twice the lease | graphile lock (stale after 4 h) plus re-enqueue every pending run on start       | pg_cron sweep every 15 s requeues tasks started more than timeout + 30 s ago, 3 times at most | Lease (`available_at`), extended at half the lease                                     | Heartbeat every 10 s, lease 60 s, reaper re-queues                     |
| **Fencing token**            | `owner_xid` UUID per claim                                                                                                                             | Attempt number (`owner_run_id` vs attempt)                                                                                 | `workflow_event_slots.seq_in_band`                                               | `status = 'started'` guard                                                                    | `worker_id`                                                                            | `attempts`                                                             |
| **Step identity**            | Call-order counter `function_id`, plus a name check (`DBOSUnexpectedStepError`)                                                                        | Step name, with `#2`, `#3` for repeats                                                                                     | Seeded ULID by call order, plus a compiler-assigned step name check              | Declared `step_slug`                                                                          | Step name, with `:1`, `:2` for repeats                                                 | —                                                                      |
| **Code changes**             | App version = MD5 of workflow source. Recovery only for the same version. `DBOS.patch()` markers                                                       | Rename the step (`:v2`); no versioning                                                                                     | `deploymentId` pinning (not on the Postgres World)                               | New `flow_slug`; startup refuses a shape mismatch                                             | Not found                                                                              | —                                                                      |
| **Durable sleep**            | Records the wake time, then **`setTimeout` in process** (the workflow stays resident)                                                                  | Checkpoint the wake time, set the run `sleeping` with `available_at`, throw `SuspendTask`                                  | Write `wait_created`, enqueue a delayed job (hops of 23 h at most), exit         | Only `startDelay` per step                                                                    | Throw `SleepSignalError`; park the run with `available_at = resumeAt`                  | `runAfter` on enqueue only                                             |
| **Messages in**              | `send` / `recv` (`notifications` table), `setEvent` / `getEvent`                                                                                       | `await_event` / `emit_event`; first emit wins; queue-wide events                                                           | Hooks with deterministic tokens; `hook_received` deduplicated by `resume_id`     | None                                                                                          | `sendSignal` → `workflow_signals` row, wakes the run                                   | None                                                                   |
| **Cancel in a running step** | `cancelSignal` AbortSignal, polled every 1 s                                                                                                           | Next checkpoint or heartbeat raises `AB001`; no AbortSignal                                                                | Run cancel waits for the step; a cooperative `AbortController` backed by a hook  | Not interrupted ("database cancellation is not process termination")                          | Fence only (not verified that the step sees it)                                        | AbortSignal at the next heartbeat (≤ 10 s)                             |
| **Per-key concurrency**      | Queue `partition_key` + per-partition concurrency                                                                                                      | None                                                                                                                       | None (internally, a graphile named queue per run)                                | None                                                                                          | None                                                                                   | None (an idempotency key per active job)                               |
| **Cron**                     | `workflow_schedules` table; every process runs the loop; dedup by workflow ID `sched-<name>-<iso time>`                                                | None (pg_cron + idempotency key, documented)                                                                               | None                                                                             | pg_cron calls `start_flow`                                                                    | `workflow_schedules` claimed with `SKIP LOCKED`, `next_run_at` moved forward           | `schedule()` throws "not supported yet"                                |
| **Children**                 | Child row + parent's step row in one transaction; `parent_workflow_id`, `child_workflow_id`                                                            | None in the schema; `awaitTaskResult` polls                                                                                | None in the schema; resume the parent's hook                                     | DAG steps and map steps; no subflows                                                          | `child_workflow_run_id` ↔ `parent_step_attempt_id`; finishing a child wakes the parent | None                                                                   |
| **Wake-ups**                 | LISTEN on `notifications` plus polling (recv 10 s, cancel 1 s, queues 1 s+). It self-tests NOTIFY and falls back if PgBouncer blocks it                | Polling only (250 ms)                                                                                                      | graphile polling 500 ms + `jobs:insert` NOTIFY; LISTEN for streams               | `pgmq.read_with_poll` (server-side long poll); no NOTIFY                                      | Polling with backoff                                                                   | Polling 2 s, plus a wake on own enqueue                                |
| **Crash tests**              | Debug trigger points at commit boundaries; recovery and "once and only once" suites; Postgres restart chaos tests                                      | pytest + testcontainers; `absurd.fake_now`; races forced with row locks on a second connection                             | World conformance suite; fence-race tests; no kill-mid-step test                 | pgTAP per SQL function; worker respawn e2e                                                    | Chaos test: 3 workers, 50 steps, random graceful stops                                 | Fake clock, lost lease, second runner on the same DB                   |

pg-boss and Hatchet are not in the table. Their useful patterns are in their own sections: pg-boss's attempt fence and per-key policies, and Hatchet's positional event log with a hash check and its concurrency strategies.

---

## DBOS Transact (TypeScript)

Base: `https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/`. All migrations are in one file, [`src/sysdb_migrations/internal/migrations.ts`](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts).

### Schema

- **`workflow_status`** (PK `workflow_uuid`): `status`, `name`, `executor_id`, `application_version`, `recovery_attempts`, `queue_name`, `queue_partition_key`, `deduplication_id`, `priority`, `workflow_deadline_epoch_ms`, `owner_xid` (the ownership token), `parent_workflow_id`, `delay_until_epoch_ms`, `forked_from`, and others. See [L39](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L39), [L115](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L115), [L126](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L126), [L195](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L195), [L221](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L221) and [L241](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L241). Inputs and outputs later moved into `workflow_input` and `workflow_output` ([L930-L940](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L930-L940)).
- **`operation_outputs`** (steps), PK `(workflow_uuid, function_id)`: `function_name`, `output`, `error`, `child_workflow_id`, started and completed times ([L37](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L37), [L150](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L150), [L217](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L217)).
- **`notifications`** (messages): `message_uuid` PK, `destination_uuid`, `topic`, `message`, `consumed`, `consumed_by_function_id` ([L40](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L40), [L270](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L270), [L1140](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L1140)).
- **`workflow_events`**, PK `(workflow_uuid, key)`, plus `workflow_events_history` for fork and rewind ([L41](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L41), [L226-L234](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L226-L234)). **`streams`**, PK `(workflow_uuid, key, offset)` ([L188](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L188)).
- **`workflow_schedules`** ([L257-L265](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L257-L265), [L391-L393](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L391-L393)) and a **`queues`** config table ([L433-L445](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L433-L445)). Queue entries have no table of their own: the old `workflow_queue` was dropped, and queue state lives on `workflow_status` ([L747](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L747)).
- The user's database gets a `transaction_completion(workflow_id, function_num, output, error)` table ([src/datasource.ts#L356-L367](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/datasource.ts#L356-L367)).

### Recording a step

- **`callStepFunction`, in order:**
  1. Takes the next `function_id`.
  2. Checks for cancellation.
  3. Reads `operation_outputs` and returns the saved result if there is one.
  4. Otherwise runs the step with retries.
  5. Records the result or error ([src/dbos-executor.ts#L913-L957](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L913-L957)).

  Its comment says: "The step may execute many times, but once it is complete, it will not re-execute" ([L890-L894](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L890-L894)). **Plain steps are at-least-once.**

- **The insert** is `INSERT … ON CONFLICT (workflow_uuid, function_id) DO UPDATE … RETURNING completed_at_epoch_ms`. A different returned time throws `DBOSStepNondeterminismError`. Before the insert, `SELECT owner_xid … FOR NO KEY UPDATE` must match the caller's token ([src/system_database.ts#L5109-L5192](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L5109-L5192)).
- **Exactly-once for database transactions.** The user's function and the insert into `transaction_completion` run in one `BEGIN … COMMIT` ([packages/nodepg-datasource/index.ts#L196-L260](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/packages/nodepg-datasource/index.ts#L196-L260)). Internal operations such as `send` and `setEvent` record their step in the same system-DB transaction ([src/system_database.ts#L1816-L1873](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L1816-L1873), [L5231-L5264](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L5231-L5264)).
- **Retries** default to 3 attempts, starting at 1 s and doubling ([src/dbos-executor.ts#L1016-L1080](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L1016-L1080)). A step timeout aborts `DBOS.stepStatus.timeoutSignal` and throws away that attempt's result ([L968-L1008](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L968-L1008)).

### Crash recovery

- **`executor_id`** comes from `DBOS__VMID`, then config, and defaults to `'local'`. The app version comes from `DBOS__APPVERSION` or a computed hash ([src/dbos.ts#L542-L561](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos.ts#L542-L561)).
- **At launch, a process recovers only its own executor ID** ([src/dbos-executor.ts#L390-L392](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L390-L392)). Recovery re-enqueues rather than running directly: `UPDATE … SET status = ENQUEUED, owner_xid = NULL WHERE status = PENDING AND executor_id = $ AND application_version = $` ([src/system_database.ts#L1605-L1629](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L1605-L1629)).
- **No lease and no heartbeat exist in the repo.** Taking over another, dead executor's work is done by the closed-source Conductor ([src/enterprise.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/enterprise.ts)).
- **Fencing instead of a lease.**
  - Each claim writes a new `owner_xid` ([src/system_database.ts#L3805-L3822](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3805-L3822)).
  - The outcome is written only `WHERE status = PENDING AND owner_xid = $` ([L1566-L1603](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L1566-L1603)).
  - A run that has lost ownership "parks" and adopts the outcome that was recorded ([src/dbos-executor.ts#L745-L867](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L745-L867)).
- **Dead letter.** `recovery_attempts` goes up on every claim. Past `maxRecoveryAttempts` (default 100), the status becomes `MAX_RECOVERY_ATTEMPTS_EXCEEDED` ([src/workflow.ts#L63](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/workflow.ts#L63), [src/dbos-executor.ts#L645-L655](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L645-L655)).

### Step identity and code changes

- **`function_id`** is an in-memory counter that restarts at 0 on each execution ([src/context.ts#L126-L150](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/context.ts#L126-L150)). `recv` takes two IDs (the message and its timeout), and so does a child call (start and getResult) ([src/dbos.ts#L1509-L1511](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos.ts#L1509-L1511), [L1976-L1987](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos.ts#L1976-L1987)).
- **Replay checks the name.** If the recorded `function_name` differs, replay throws `DBOSUnexpectedStepError` ([src/dbos-executor.ts#L948-L951](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L948-L951)).
- **App version** is the MD5 of the sorted source text (`toString()`) of every registered workflow ([L1416-L1437](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos-executor.ts#L1416-L1437)). Recovery and dequeue filter on it ([src/system_database.ts#L3756-L3760](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3756-L3760)).
- **Patching.**
  - `DBOS.patch(name)` writes a `DBOS.patch-<name>` marker at the current `function_id`. When a different step is already in that slot, the run is treated as unpatched.
  - `deprecatePatch` skips a matching marker.
  - Turning patching on pins the version to `'PATCHING_ENABLED'`.
  - Sources: [src/dbos.ts#L2164-L2232](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/dbos.ts#L2164-L2232), [src/system_database.ts#L1875-L1923](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L1875-L1923).

### Sleep, messages, cancellation

- **`DBOS.sleepms` records the wake time as a step, then loops on `setTimeout`.** The workflow stays resident and still counts toward queue concurrency. After a crash, replay sleeps only the remainder ([src/system_database.ts#L5279-L5317](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L5279-L5317), [L2886-L2894](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L2886-L2894)).
- **`send`** inserts into `notifications` with `ON CONFLICT (message_uuid) DO NOTHING` (the key is `idempotencyKey::dest`) and records its step in the same transaction ([L2899-L2944](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L2899-L2944)).
- **`recv`** registers a NOTIFY callback, queries, then races the NOTIFY against a poll of up to 10 s. It consumes the oldest message (`UPDATE … SET consumed = true`) and records the step in one transaction ([L3024-L3149](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3024-L3149)).
- **`setEvent` / `getEvent`** follow the same pattern ([L3152-L3313](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3152-L3313)).
- **`cancelWorkflows`** sets `CANCELLED` and `owner_xid = NULL`. `cancelChildren` walks the descendants ([L1926-L1956](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L1926-L1956)).
- **How a running workflow learns of a cancel:**
  - At each step boundary.
  - Inside a step, through `DBOS.stepStatus.cancelSignal`. A shared poller checks every watched ID every 1 s and aborts its controller ([src/system_database.ts#L2691-L2757](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L2691-L2757), [src/step.ts#L18-L25](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/step.ts#L18-L25)).

### Queues and per-key concurrency

- **`findAndMarkStartableWorkflows`** selects `ENQUEUED` rows (optionally `AND queue_partition_key = $`) `FOR UPDATE SKIP LOCKED`, and flips them to `PENDING` with a fresh `owner_xid`.
  - The isolation level rises to REPEATABLE READ or SERIALIZABLE when a queue-wide limit applies.
  - Global concurrency counts PENDING rows in the database.
  - Worker concurrency is counted in memory.
  - Source: [src/system_database.ts#L3635-L3841](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3635-L3841).
- **Partition concurrency of 1.** A recursive-CTE index scan finds the partition keys that have no PENDING row and takes the head of each ([L3843-L4017](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3843-L4017)).
- **Polling** starts at 1 s and backs off on lock contention ([src/wfqueue.ts#L716-L797](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/wfqueue.ts#L716-L797)).
- **Deduplication** uses a unique index on `(queue_name, deduplication_id)` ([migrations.ts#L479](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L479)).

### Cron and children

- **Cron.** Every process runs every schedule's loop. A duplicate firing is stopped by the deterministic workflow ID `sched-<name>-<ISO time>`, inserted with `ON CONFLICT (workflow_uuid)`. Backfill starts from `last_fired_at` ([src/scheduler/scheduler.ts#L264-L352](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/scheduler/scheduler.ts#L264-L352)).
- **Children.** `initChildWorkflowStatus` inserts the child's row (with `parent_workflow_id`) and the parent's step row (with `child_workflow_id`) in one transaction, after checking the parent's owner ([src/system_database.ts#L1223-L1271](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L1223-L1271)).
- **Workflow ID idempotency.** The insert uses `ON CONFLICT (workflow_uuid) DO UPDATE SET creator_xid = creator_xid`, and only the creator runs the workflow ([L4893-L4986](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L4893-L4986)).
- **Fork** copies the steps before a chosen step into a new workflow ([L2333-L2540](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L2333-L2540)).

### LISTEN/NOTIFY

- A trigger on `notifications` calls `pg_notify`. The triggers on events and streams were dropped in favour of a NOTIFY from the app, sent in batches every 10 ms ([migrations.ts#L701-L720](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/sysdb_migrations/internal/migrations.ts#L701-L720), [src/system_database.ts#L3473-L3548](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L3473-L3548)).
- One client LISTENs. It runs a 3 s self-test of NOTIFY; when that fails, it warns that a transaction-mode PgBouncer may be in the way and falls back to polling ([L5356-L5448](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/system_database.ts#L5356-L5448)).

### Crash-safety tests

- **[tests/timinghole.test.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/tests/timinghole.test.ts#L181-L836)** uses debug trigger points placed at commit boundaries ([src/debugpoint.ts#L28-L39](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/src/debugpoint.ts#L28-L39)). Its cases include `step-commit-hiccup`, `stale-owner-cannot-write-the-outcome` and `child-init-is-atomic-with-the-parent-step`.
- **[tests/recovery.test.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/tests/recovery.test.ts#L117-L387)** simulates a crash by forcing rows back to PENDING.
- **[tests/oaoo.test.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/tests/oaoo.test.ts#L52-L715)** checks that each operation runs once and only once.
- **[chaos-tests/](https://github.com/dbos-inc/dbos-transact-ts/blob/8643d389db64351f2acfce45e96e9747b4be8465/chaos-tests/helpers.ts#L5-L35)** restarts Postgres every 5–10 s.

**Unverified.**

- How Conductor detects dead executors.
- The data sources other than node-pg (grep shows the same pattern).
- The bodies of most test cases.

---

## Absurd

Base: `https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/`. The core is PL/pgSQL in [`sql/absurd.sql`](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql). The TypeScript SDK is [`sdks/typescript/src/index.ts`](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts). Workers pull work by polling.

### Schema

Each queue gets its own generated tables ([sql/absurd.sql#L8-L14](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L8-L14)):

- **`t_<q>`**, tasks: `task_id`, `task_name`, `params`, `retry_strategy`, `max_attempts`, `cancellation`, `state`, `attempts`, `completed_payload`, `idempotency_key` ([L222-L243](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L222-L243)).
- **`r_<q>`**, runs (one per attempt): `run_id`, `task_id`, `attempt`, `state`, `claimed_by`, `claim_expires_at`, `available_at`, `wake_event`, `event_payload`, `result`, `failure_reason` ([L245-L265](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L245-L265)).
- **`c_<q>`**, checkpoints: PK `(task_id, checkpoint_name)`, plus `state`, `status`, `owner_run_id` ([L267-L279](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L267-L279)).
- **`e_<q>`**, events: PK `event_name`, plus `payload`. Events are scoped to the queue, not to a task ([L281-L288](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L281-L288)).
- **`w_<q>`**, waits: PK `(run_id, step_name)`, plus `event_name`, `timeout_at` ([L290-L302](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L290-L302)).

### Recording a step

- **`ctx.step(name, fn)`** looks up the checkpoint. If there is none, it runs `fn()` and then writes the checkpoint as a separate statement ([sdks/typescript/src/index.ts#L350-L395](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L350-L395)).
- **`set_task_checkpoint_state`** does three things ([sql/absurd.sql#L1460-L1545](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1460-L1545)):
  - refuses the write if the task is cancelled (`AB001`) or the run has failed (`AB002`);
  - **extends the lease**;
  - upserts only when the writer's attempt is at least the owner's.
- **On resume**, only committed checkpoints from attempts up to the current one are visible, and they are preloaded into memory ([L1637-L1690](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1637-L1690)).
- **Side effects are at-least-once.** The docs say "close to 'exactly once'" and advise deriving idempotency keys from the task ID ([docs/concepts.md#L27-L30](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/docs/concepts.md#L27-L30), [L362-L366](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/docs/concepts.md#L362-L366)).

### Crash recovery

- **A claim is a lease.** `claim_task(queue, worker_id, claim_timeout, qty)` sets `claim_expires_at` and takes runs `FOR UPDATE SKIP LOCKED` ([sql/absurd.sql#L906-L1070](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L906-L1070)).
- **There is no separate reaper.** Every `claim_task` first fails up to `qty` expired leases with reason `$ClaimTimeout` ([L977-L1006](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L977-L1006)). `fail_run` then inserts a new run as attempt + 1, so a lost lease uses up an attempt ([L1256-L1300](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1256-L1300)).
- **The lease is extended** by `ctx.heartbeat()` and by every checkpoint write ([L1547-L1606](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1547-L1606)).
- **The worker fences itself.** It warns at the lease timeout and calls `process.exit(1)` at twice the lease (`fatalOnLeaseTimeout`, on by default) ([sdks/typescript/src/index.ts#L1254-L1277](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L1254-L1277)).
- **Retry strategies** are none, fixed, or exponential (base 30 s, factor 2) ([sql/absurd.sql#L54-L129](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L54-L129)).

### Step identity and code changes

- **A checkpoint's key is the step name.** Repeats in the same execution become `name#2`, `name#3` ([sdks/typescript/src/index.ts#L429-L434](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L429-L434)).
- **No versioning.** The docs say to rename a step (`process-payment:v2`) or to translate old values forward in the code ([docs/patterns/living-with-code-changes.md#L10-L22](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/docs/patterns/living-with-code-changes.md#L10-L22)).
- **An unregistered task name** is deferred for 15 s, not failed ([index.ts#L1291-L1318](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L1291-L1318)).

### Sleep, events, cancellation

- **Sleep holds no worker.** `sleepUntil` checkpoints the wake time, calls `schedule_run`, which sets the run to `sleeping` with `available_at` and clears the claim, and throws `SuspendTask`. The executor swallows that error ([index.ts#L409-L427](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L409-L427), [sql/absurd.sql#L1135-L1179](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1135-L1179), [index.ts#L1333-L1341](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L1333-L1341)). The next claim replays the task from the top, using the cached checkpoints.
- **`await_event`** first checks for a checkpoint. If there is none, it inserts a sentinel event row, locks it `FOR SHARE` and locks the run. If the event was already emitted, it checkpoints the payload. Otherwise it writes a wait row and sleeps the run until the event arrives or the timeout passes ([sql/absurd.sql#L1692-L1877](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1692-L1877)).
- **`emit_event`** keeps the first write (`WHERE payload IS NULL`). In one statement it wakes every waiter, writes their checkpoints and deletes their waits ([L1879-L1971](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1879-L1971)). A test covers the lost-wakeup race ([tests/test_events.py#L165-L173](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/tests/test_events.py#L165-L173)).
- **`cancel_task`** locks the runs, then the task, and marks both cancelled ([L1973-L2040](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L1973-L2040)). Running code finds out at its next checkpoint or heartbeat, which raises `AB001`. User code gets no AbortSignal ([index.ts#L1392-L1400](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L1392-L1400)). The policies `max_delay` and `max_duration` also cancel, at claim time ([L947-L975](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L947-L975)).

### Concurrency, cron, children, wake-ups

- **Concurrency.** There is no per-key concurrency, only a `concurrency` setting per worker ([index.ts#L1120-L1187](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L1120-L1187); [docs/comparison.md#L104-L116](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/docs/comparison.md#L104-L116)).
- **Cron is not built in.** The docs show pg_cron or an external scheduler calling `spawn` with the idempotency key `name + cron + slot` ([docs/patterns/cron.md#L1-L21](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/docs/patterns/cron.md#L1-L21)).
- **Children.** The schema has no parent link. `awaitTaskResult` polls the child from inside a step, and refuses to wait on the same queue so it can't deadlock a worker slot ([index.ts#L547-L586](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L547-L586)).
- **Wake-ups are polling only:** every 250 ms when idle, and at once when a slot frees ([L1120-L1163](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sdks/typescript/src/index.ts#L1120-L1163)).

### Crash-safety tests

- Python pytest runs against a real Postgres in testcontainers ([tests/conftest.py](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/tests/conftest.py#L12-L28)).
- Time is controlled through the `absurd.fake_now` setting, which `absurd.current_time()` reads ([sql/absurd.sql#L35-L52](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/sql/absurd.sql#L35-L52)).
- Races are made deterministic by holding row locks on a second connection and watching `pg_stat_activity` ([tests/test_lock_ordering.py#L13-L28](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/tests/test_lock_ordering.py#L13-L28)).
- A test checks that a claim timeout hands the run to a new worker ([tests/test_state_transitions.py#L41-L89](https://github.com/earendil-works/absurd/blob/5b97022ac6d1523cda92470db3b6731909cae571/tests/test_state_transitions.py#L41-L89)).

**Unverified.**

- The Python and Go SDKs.
- Whether `claimed_by` is used for anything beyond diagnostics.

---

## Workflow SDK with the Postgres World

Base: `https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/`. Schema: [`packages/world-postgres/src/drizzle/schema.ts`](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts).

### Schema

All tables are in the Postgres schema `workflow`:

- **`workflow_runs`**: `deployment_id`, `status`, CBOR-encoded input, output and error ([L89-L166](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L89-L166)).
- **`workflow_events`**, the event log, PK `(run_id, id)`. A partial unique index on `(run_id, correlation_id, type)` covers created events, and one on `(run_id, resume_id)` covers `hook_received` ([L168-L219](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L168-L219)).
- **`workflow_event_slots`** (`run_id`, `seq_in_band`), a counter that fences writers ([L232-L242](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L232-L242)).
- **`workflow_steps`**, a materialised row per step: `status`, `attempt`, `retry_after` ([L244-L285](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L244-L285)).
- **`workflow_hooks`** (`token` indexed) ([L287-L318](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L287-L318)).
- **`workflow_waits`** ([L320-L336](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L320-L336)).
- **`workflow_stream_chunks`** ([L385-L399](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/drizzle/schema.ts#L385-L399)).
- **Jobs** are graphile-worker's tables, under the task identifier `workflow_flows` ([queue.ts#L270-L273](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L270-L273)).

### Recording a step

- **`step_completed` and `step_failed`.** A guarded update to `workflow_steps` (`WHERE status NOT IN terminal`) and the event insert run in **one transaction**. The code comment says that committing them separately could strand a run ([storage.ts#L2298-L2380](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/storage.ts#L2298-L2380)).
- **`step_started`** increments `attempt` inside its transaction. The first start's insert, with `ON CONFLICT DO NOTHING`, is "the ownership claim" ([L2149-L2296](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/storage.ts#L2149-L2296)).
- **Fence.** An orchestrator write locks `workflow_event_slots FOR UPDATE` and compares `expectedSeqInBand`; on a mismatch it throws `InBandSupersededError` ([L1132-L1215](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/storage.ts#L1132-L1215)).
- **Side effects are at-least-once.** The docs say "workflow and step handlers still need to tolerate at-least-once execution" ([HOW_IT_WORKS.md#L63](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/HOW_IT_WORKS.md#L63)). The code lists duplicate step runs across processes as a residual risk on self-hosted worlds ([core/src/runtime/step-single-flight.ts#L5-L30](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/step-single-flight.ts#L5-L30)).
- **Retries.** A step retries 3 times by default ([step-executor.ts#L74](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/step-executor.ts#L74)).

### Crash recovery

- **The Postgres World has no heartbeat of its own.** Recovery is "Graphile releasing the job when the worker dies, plus `reenqueueActiveRuns` on start" ([queue.ts#L105-L114](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L105-L114)). graphile releases a stale lock only after 4 hours (see graphile-worker below).
- **On start, every pending or running run is re-enqueued**, relying on replay being idempotent ([world/src/recovery.ts#L10-L65](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world/src/recovery.ts#L10-L65)).
- **Inline steps hold an ownership lease** of 860 s by default. The constants file notes there is "no death proof from any constant" on self-hosted worlds ([core/src/runtime/constants.ts#L455-L503](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/constants.ts#L455-L503)).

### Step identity and code changes

- **Correlation IDs** are `step_<ULID>`. The ULID comes from a VM `Math.random` seeded with `runId:workflowName:deploymentId` and a fixed timestamp, so an ID depends on call order ([core/src/workflow.ts#L417-L494](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/workflow.ts#L417-L494), [core/src/step.ts#L28](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/step.ts#L28)).
- **Step names** are assigned by the SWC plugin as `step//<module>//<fn>` ([swc-plugin-workflow/spec.md#L68-L84](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/swc-plugin-workflow/spec.md#L68-L84)). Replay compares names and throws `ReplayDivergenceError` on a mismatch ([core/src/step.ts#L80-L97](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/step.ts#L80-L97)).
- **Deployment pinning** sends a delivery back to the run's deployment, but only when the world sets `deploymentAffinity` ([deployment-guard.ts#L86-L167](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/deployment-guard.ts#L86-L167)). The Postgres World doesn't set it and reports `getDeploymentId() = 'postgres'` ([queue.ts#L404-L406](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L404-L406)). _(inference)_ On Postgres, a deploy therefore replays old runs on new code.

### Sleep, hooks, cancellation

- **`sleep()`** writes `wait_created` and ends the invocation with `{ timeoutSeconds }`. The worker adds a delayed graphile job **before** it acks, "so a crash cannot lose the wake-up request" ([queue.ts#L1011-L1034](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L1011-L1034)). Long waits are chained in hops of 23 h at most ([core/src/runtime/wait-continuation.ts#L1-L40](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/wait-continuation.ts#L1-L40)).
- **Hooks.** A token is the caller's or a seeded nanoid ([core/src/workflow/hook.ts#L119-L121](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/workflow/hook.ts#L119-L121)). `resumeHook` writes a durable `hook_received` event, deduplicated by `resume_id`, then queues a wake-up with the key `hook-<resumeId>` ([core/src/runtime/resume-hook.ts#L918-L982](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/resume-hook.ts#L918-L982)).
- **Cancelling a run lets a running step finish.** The docs say "Steps that are currently executing will run to completion" ([docs/…/foundations/cancellation.mdx#L366](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/docs/content/docs/v5/foundations/cancellation.mdx#L366)). A cooperative `AbortController` is backed by a hook plus a stream that a reader inside the step watches ([core/src/workflow/abort-controller.ts#L12-L60](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/workflow/abort-controller.ts#L12-L60)).

### Concurrency, cron, children, wake-ups

- **Concurrency.** There is no per-key concurrency for users; the docs say to "enforce limits inside steps or debounce at the publisher" ([comparisons/workflow-sdk-vs-trigger-dev.mdx#L31](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/docs/content/docs/v5/comparisons/workflow-sdk-vs-trigger-dev.mdx#L31)). Internally, with `enableInvoke`, each run gets a serial graphile queue named `flows:<runId>:executor` ([queue.ts#L288-L290](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L288-L290)).
- **No cron in the code.** The docs suggest a system cron calling `start()`, or a sleep loop ([cookbook/…/scheduling.mdx#L12-L16](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/docs/content/docs/v5/cookbook/common-patterns/scheduling.mdx#L12-L16)).
- **Children.** The schema has no parent link. Awaiting `run.returnValue` polls, and inside a step it blocks a worker slot ([core/src/runtime/run.ts#L597-L640](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/core/src/runtime/run.ts#L597-L640)). The recommended pattern is for the child to resume the parent's hook ([cookbook/advanced/child-workflows.mdx#L32-L34](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/docs/content/docs/v5/cookbook/advanced/child-workflows.mdx#L32-L34)).
- **Wake-ups.** The queue polls every 500 ms, and graphile's NOTIFY "only wakes idle workers early" ([queue.ts#L1101](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L1101)). Streams use LISTEN, with a re-read after reconnecting, because a NOTIFY sent during an outage is lost ([streamer.ts#L49-L76](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/streamer.ts#L49-L76)).

### Crash-safety tests

- A shared world conformance suite runs against a Postgres testcontainer; it is skipped on Windows ([world-postgres/test/spec.test.ts#L11-L36](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/test/spec.test.ts#L11-L36)).
- Fence races ([test/in-band-fence.test.ts#L112-L319](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/test/in-band-fence.test.ts#L112-L319)).
- Re-enqueue on restart ([src/reenqueue.test.ts#L188-L268](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/reenqueue.test.ts#L188-L268)).
- No test kills a process in the middle of a step.

**Unverified.**

- How the runtime decides between an inline and a queued step (`runtime.ts`, 5.7k lines).
- Whether `wait_completed` writes are fenced.
- `HOW_IT_WORKS.md` says 3 attempts and concurrency 10, but the code has 73 graphile attempts and concurrency 50 ([queue.ts#L142-L155](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L142-L155), [L1085-L1103](https://github.com/vercel/workflow/blob/7882c81480b99241090f5c316250c8203c1c2ba1/packages/world-postgres/src/queue.ts#L1085-L1103)).

---

## graphile-worker

Base: `https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/`. It's a job queue: it has no steps, events or hooks.

### Schema and claim

- **`_private_jobs`** columns: `job_queue_id`, `task_id`, `payload`, `run_at`, `attempts`, `max_attempts` (default 25), `key` (unique), `locked_at`, `locked_by`. A generated `is_available` column is true when the job is unlocked and has attempts left ([sql/000011.sql#L50-L81](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/sql/000011.sql#L50-L81)).
- **`_private_job_queues`**: `queue_name`, `locked_at`, `locked_by` ([L35-L41](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/sql/000011.sql#L35-L41)).
- **`_private_known_crontabs`**: `identifier`, `last_execution` ([sql/000008.sql#L1-L5](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/sql/000008.sql#L1-L5)).
- **Claim, complete, fail.**
  - A claim is `FOR UPDATE SKIP LOCKED`, then `attempts + 1, locked_by, locked_at` ([src/sql/getJobs.ts#L230-L251](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/sql/getJobs.ts#L230-L251)).
  - Success deletes the row ([completeJobs.ts#L30-L85](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/sql/completeJobs.ts#L30-L85)), so delivery is at-least-once.
  - A failure backs off by `exp(least(attempts, 10))` seconds ([failJobs.ts#L40-L50](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/sql/failJobs.ts#L40-L50)).

### Recovery, cancellation, keys

- **No heartbeat.** Every pool clears locks older than a hard-coded **4 hours**, at random intervals of 8–10 minutes ([src/sql/resetLockedAt.ts#L18-L33](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/sql/resetLockedAt.ts#L18-L33), [src/config.ts#L64-L65](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/config.ts#L64-L65)). Version 0.16.6, the one world-postgres uses, has the same window ([resetLockedAt.ts @ v0.16.6](https://github.com/graphile/worker/blob/5650fbc4406fa3ce197b2ab582e08fd20974e50c/src/sql/resetLockedAt.ts#L24-L28)).
- **Graceful shutdown** releases the workers, then fires the task's `abortSignal` after 5 s ([src/main.ts#L836-L971](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/main.ts#L836-L971)).
- **`remove_job(key)`** can't stop a locked job. It clears the key and sets `attempts = max_attempts`, and the running attempt carries on ([sql/000018.sql#L177-L206](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/sql/000018.sql#L177-L206)).
- **`job_key` modes** are `replace`, `preserve_run_at` and `unsafe_dedupe`. If the existing job is locked, its key is released and a new job is inserted ([sql/000020.sql#L24-L190](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/sql/000020.sql#L24-L190)).
- **Per-key concurrency is exactly 1 per named queue.** The queue row is locked `FOR UPDATE SKIP LOCKED` at claim and unlocked on complete or fail ([src/sql/getJobs.ts#L139-L228](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/sql/getJobs.ts#L139-L228)).

### Cron and wake-ups

- **Cron.** One CTE moves `last_execution` forward only when the new value is newer, and calls `add_job` only for the rows it won, so several instances never double-fire. Backfill walks minute by minute ([src/cron.ts#L117-L188](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/cron.ts#L117-L188), [L238-L290](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/cron.ts#L238-L290)).
- **Wake-ups.** An insert sends NOTIFY `jobs:insert`, and idle workers wake ([src/main.ts#L465-L483](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/main.ts#L465-L483)). They also poll every 2 s ([src/worker.ts#L212-L223](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/worker.ts#L212-L223)).
- **Tests.** Stale-lock reset ([**tests**/resetLockedAt.test.ts#L21-L80](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/__tests__/resetLockedAt.test.ts#L21-L80)) and a multi-instance load harness ([towerDefence/README.md](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/towerDefence/README.md#L1-L15)).

**Unverified.**

- `helpers.addJob`, the local queue, and the cleanup task.
- Some line ranges in `failJobs.ts` and `returnJobs.ts` may be off by a line or two.

---

## pgflow

Base: `https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/`. A flow is a DAG of steps declared up front and run through pgmq queues; nothing is replayed. It targets Supabase: edge workers, pg_cron, Realtime.

### Schema and recording

- **Definition tables.** `flows` holds `flow_slug`, default retry settings and timeout. `steps` holds `step_slug`, `step_type` (`single` or `map`), `deps_count` and the per-step overrides. `deps` holds the edges ([pkgs/core/schemas/0050_tables_definitions.sql#L3-L72](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0050_tables_definitions.sql#L3-L72)).
- **Runtime tables** ([0060_tables_runtime.sql#L3-L135](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0060_tables_runtime.sql#L3-L135)):
  - `runs`: `remaining_steps`.
  - `step_states`: `remaining_tasks`, `remaining_deps`, `output`.
  - `step_tasks`: PK `(run_id, step_slug, task_index)`, plus `message_id`, `attempts_count`, `last_worker_id`, `requeued_count`.
- **`workers`**: `last_heartbeat_at` ([0055_tables_workers.sql](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0055_tables_workers.sql#L3-L15)).
- **`complete_task`** works in three stages ([0100_function_complete_task.sql#L31-L424](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0100_function_complete_task.sql#L31-L424)):
  1. Locks the run and the step state, and ignores late callbacks.
  2. In one CTE: completes the task (guarded by `status = 'started'`), decrements the counters, stores the step's output and unblocks dependents.
  3. Archives the pgmq message and starts the steps that are now ready.
- **Handlers are at-least-once.** The docs recommend using `(run_id, step_slug, task_index)` as the idempotency key ([failures-and-termination.mdx#L215-L225](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/website/src/content/docs/concepts/failures-and-termination.mdx#L215-L225)).

### Recovery and versioning

- **Two-phase claim.** First `pgmq.read_with_poll` with a 2 s visibility timeout. Then `start_tasks` claims only `queued` tasks and extends the visibility timeout to the step timeout + 2 s ([0120_function_start_tasks.sql#L142-L258](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0120_function_start_tasks.sql#L142-L258)).
- **Orphaned work is picked up by a pg_cron sweep every 15 s.** It requeues tasks started more than timeout + 30 s ago, at most 3 times, then marks them `permanently_stalled_at`. It uses `started_at`, not worker heartbeats ([0062_function_requeue_stalled_tasks.sql#L1-L109](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0062_function_requeue_stalled_tasks.sql#L1-L109), [0063_…cron.sql#L111-L148](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0063_function_setup_requeue_stalled_tasks_cron.sql#L111-L148)).
- **Worker heartbeats** drive only worker deprecation and `ensure_workers` ([0059_function_ensure_workers.sql#L51-L78](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0059_function_ensure_workers.sql#L51-L78)).
- **Versioning by slug.** At startup, `ensure_flow_compiled` compares the stored shape with the worker's shape. In production a mismatch stops the worker from starting ([0100_function_ensure_flow_compiled.sql#L1-L186](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0100_function_ensure_flow_compiled.sql#L1-L186)). A change needs a new `flow_slug` ([build/version-flows.mdx#L10-L41](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/website/src/content/docs/build/version-flows.mdx#L10-L41)).

### What it lacks

- **No sleep inside a handler**, only a `startDelay` per step through `pgmq.send_batch(…, delay)` ([0100_function_start_ready_steps.sql#L73-L117](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0100_function_start_ready_steps.sql#L73-L117)).
- **No events or signals into a run.** Input comes only through `start_flow` ([0100_function_start_flow.sql#L1-L10](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/schemas/0100_function_start_flow.sql#L1-L10)).
- **No cancel API, and a running handler is never interrupted.** The docs say "Database cancellation is not process termination" ([failures-and-termination.mdx#L14-L18](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/website/src/content/docs/concepts/failures-and-termination.mdx#L14-L18)).
- **No per-key concurrency.**
- **Cron** is pg_cron calling `start_flow` ([starting-flows/pg-cron.mdx#L23-L31](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/website/src/content/docs/build/starting-flows/pg-cron.mdx#L23-L31)).
- **No LISTEN/NOTIFY.** pgmq polls on the server side ([pkgs/core/src/PgflowSqlClient.ts#L20-L37](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/src/PgflowSqlClient.ts#L20-L37)).
- **Tests** are pgTAP files, one per SQL function, for example the stalled-task requeue ([pkgs/core/supabase/tests/requeue_stalled_tasks/basic_requeue.test.sql](https://github.com/pgflow-dev/pgflow/blob/9160db62009f9535264824a7e76593c2e09b1769/pkgs/core/supabase/tests/requeue_stalled_tasks/basic_requeue.test.sql#L1-L30)).

**Unverified.**

- The internals of the cascade and skip functions.
- Any run-level cancel outside SQL.

---

## OpenWorkflow

Base: `https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/`. A small TypeScript engine (about 1.3k stars) with Postgres and SQLite backends.

- **Schema** ([postgres/postgres.ts#L82-L312](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/postgres.ts#L82-L312)):
  - `workflow_runs`: `status`, `attempts`, `worker_id`, `available_at` (the lease expiry and also the wake time), `deadline_at`, `parent_step_attempt_id`, `idempotency_key`.
  - `step_attempts`: `step_name`, `step_index`, `kind`, `status`, `output`, `child_workflow_run_id`.
  - `workflow_signals`, unique per `step_attempt_id`.
  - `workflow_schedules`: `cron`, `timezone`, `next_run_at`.
- **Claim.** One statement fails runs past their deadline, then takes a due run with `FOR UPDATE SKIP LOCKED` and sets `worker_id`, `available_at = now + lease` and `attempts + 1` ([postgres/backend.ts#L690-L743](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L690-L743)).
- **Heartbeat.** The lease is extended at half its length, fenced on `worker_id = me` ([worker/worker.ts#L362-L392](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/worker/worker.ts#L362-L392)).
- **Step write.** It locks the owned run (`FOR NO KEY UPDATE`), so a lease transfer is serialised with the step write; the update is idempotent ([backend.ts#L1169-L1262](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L1169-L1262)).
- **Identity** is the step name, with `:1` and `:2` added for repeats ([worker/step-history.ts#L215-L261](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/worker/step-history.ts#L215-L261)).
- **Sleep** throws `SleepSignalError`; the run is parked with `worker_id = NULL` and `available_at = resumeAt` ([worker/execution.ts#L508-L530](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/worker/execution.ts#L508-L530), [backend.ts#L764-L781](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L764-L781)).
- **Signals.** In one transaction, `sendSignal` locks the waiting attempt and its run, inserts the signal with `ON CONFLICT DO NOTHING`, and wakes the run if nobody owns it ([backend.ts#L524-L610](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L524-L610)).
- **Cancel** sets `canceled` and `worker_id = NULL`; the old worker's fenced writes then match no row ([backend.ts#L948-L975](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L948-L975)).
- **Children** link through `child_workflow_run_id` and `parent_step_attempt_id`, and a finished child wakes its parent ([backend.ts#L980-L1013](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L980-L1013)).
- **Cron.** Due schedules are taken with `SKIP LOCKED`; `next_run_at` moves forward and the run is inserted in the same transaction ([backend.ts#L316-L353](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/postgres/backend.ts#L316-L353)).
- **Wake-ups** are polling only, with backoff.
- **Chaos test.** Three workers and 50 steps, with workers stopped at random. They are stopped gracefully, not killed ([worker/chaos.test.ts#L15-L102](https://github.com/openworkflowdev/openworkflow/blob/258bae924d7211a2383762fd8b03dff42b872f83/packages/openworkflow/worker/chaos.test.ts#L15-L102)).

**Unverified.**

- Whether a running step gets an abort signal on cancel.
- The licence.

---

## pg-boss (patterns only)

Base: `https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/`. A job queue with no steps.

- **Attempt fence.** `retry_count` names the attempt. Complete, fail, cancel and touch all match `state = 'active' AND id || ':' || retry_count = ANY($n)`, so a stale worker can't settle a newer attempt ([src/plans.ts#L2828-L2897](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L2828-L2897)). Tests: [test/attemptFenceTest.ts#L79-L118](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/test/attemptFenceTest.ts#L79-L118).
- **Heartbeat** is opt-in through `heartbeatSeconds`. The worker touches at half the interval, and a touch that fails aborts that job's `AbortSignal` ([src/manager.ts#L678-L735](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/manager.ts#L678-L735)).
- **Per-key policies** are partial unique indexes on `(name, singleton_key)` ([src/plans.ts#L1363-L1411](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L1363-L1411)):
  - `singleton`: one active job per key;
  - `stately`: one job per state;
  - `exclusive`: one queued or active job;
  - `key_strict_fifo`: first in, first out per key.
- **Cron.** One instance wins each pass with `UPDATE version SET cron_on = now() WHERE now() - cron_on >= interval`. Each firing is deduplicated by a singleton key and a time slot ([src/plans.ts#L1634-L1678](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L1634-L1678), [src/timekeeper.ts#L598-L646](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/timekeeper.ts#L598-L646)).
- **NOTIFY is an opt-in wake-up hint over polling.** After a reconnect, every worker fetches ([src/notifier.ts#L14-L73](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/notifier.ts#L14-L73)).

## Hatchet (patterns only)

Base: `https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/`. A Go engine that needs its own service. It is read here for its durable event log.

- **Durable event log.** `v1_durable_event_log_entry` has kinds `RUN | WAIT_FOR | MEMO` and PK `(durable_task_id, inserted_at, branch_id, node_id)`. Each entry also stores an `idempotency_key` ([sql/schema/v1-core.sql#L2984-L3042](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/sql/schema/v1-core.sql#L2984-L3042)).
- **Identity is positional:** `node_id = latest_node_id + 1`. The stored key is a hash of the kind plus its options. A mismatch at the same node raises `NonDeterminismError` ([pkg/repository/durable_events.go#L1106-L1137](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/pkg/repository/durable_events.go#L1106-L1137), [L2075](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/pkg/repository/durable_events.go#L2075)).
- **Recovery uses the worker heartbeat.** Workers beat every 5 s. A task whose worker hasn't beaten in 30 s is reassigned with `SKIP LOCKED` ([pkg/repository/sqlcv1/tasks.sql#L605-L624](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/pkg/repository/sqlcv1/tasks.sql#L605-L624)). A durable task that is waiting can be evicted to free its slot, then restored ([tasks.sql#L1308-L1351](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/pkg/repository/sqlcv1/tasks.sql#L1308-L1351)).
- **Concurrency strategies** are `GROUP_ROUND_ROBIN`, `CANCEL_IN_PROGRESS`, `CANCEL_NEWEST` and others, over `v1_concurrency_slot (strategy_id, key, sort_id)`. `CANCEL_IN_PROGRESS` keeps the newest runs for each key and cancels the rest ([v1-core.sql#L316](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/sql/schema/v1-core.sql#L316), [sqlcv1/concurrency.sql#L416-L475](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/pkg/repository/sqlcv1/concurrency.sql#L416-L475)).
- **Cancel is a best-effort push** over the worker's gRPC stream ("we don't currently have worker-side acks") ([internal/services/dispatcher/subscribed_worker_v1.go#L191-L219](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/internal/services/dispatcher/subscribed_worker_v1.go#L191-L219)).
- **Cron.** A cron with no ticker, or whose ticker is dead, is claimed with `SKIP LOCKED` ([sqlcv1/ticker.sql#L96-L133](https://github.com/hatchet-dev/hatchet/blob/c205f596ec45936e11044f48e8ac61cc4cdc3f6d/pkg/repository/sqlcv1/ticker.sql#L96-L133)).

**Unverified.**

- Hatchet's test files: listed, not read.
- The TypeScript SDK's cancel handling.
- How a satisfied `WAIT_FOR` resumes a task.

---

## Today's in-house runner, for comparison

Base: `https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/`.

- **Schema.** One `chat.job` table: `name`, `payload`, `status` (`queued | running | succeeded | failed | cancelled`), `attempts`, `max_attempts` (3), `run_after`, `heartbeat_at`, `last_error`, `idempotency_key`. The key is unique among active jobs only. There's an index on `(status, run_after)` ([core/server/db/schema/job.ts#L20-L45](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/db/schema/job.ts#L20-L45)). There are no step, event, message or schedule tables.
- **Claim.** `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` sets `running` and `attempts + 1` ([core/server/jobs/store.ts#L66-L98](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/store.ts#L66-L98)).
- **Fence.** `ownAttempt` matches `id`, `status = 'running'` and `attempts`. That is the same idea as pg-boss's `id:retry_count` ([store.ts#L110-L113](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/store.ts#L110-L113)).
- **Heartbeat and lease.** A running job heartbeats every 10 s and holds a 60 s lease, with a 15-minute cap per attempt ([core/server/jobs/define.ts#L175-L186](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/define.ts#L175-L186)). A heartbeat that finds the row gone aborts the handler's `signal` ([store.ts#L213-L230](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/store.ts#L213-L230)).
- **Reaper.** It re-queues jobs whose lease expired, and fails a job that was on its last attempt ([store.ts#L256-L284](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/store.ts#L256-L284)).
- **Retries** wait about 10 s, 1 min and 5 min. A `PermanentJobError` fails the job at once ([define.ts#L99-L170](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/define.ts#L99-L170)).
- **Cancel.** `cancel(idempotencyKey)` marks the job `cancelled`, and a running handler is aborted at its next heartbeat ([store.ts#L286-L292](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/store.ts#L286-L292)).
- **Polling** every 2 s, plus a wake-up on the process's own enqueue. There's no LISTEN/NOTIFY, because ADR 0011 says it breaks behind connection pooling ([core/server/jobs/in-process.ts#L384-L467](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/in-process.ts#L384-L467)). DBOS hits the same problem and handles it with a self-test that falls back to polling.
- **`schedule()` throws** "Recurring jobs are not supported yet" ([in-process.ts#L444-L446](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/core/server/jobs/in-process.ts#L444-L446)). ADR 0011 designs it as `everyMs` slots under the key `name:<slot>`, which is the same slot-key idea as DBOS's `sched-<name>-<time>` and pg-boss's throttle slot.
- **Tests** use an injected `JobClock` and a real Postgres. They cover:
  - lease expiry and re-queue;
  - "ignores a lost attempt that ends after another attempt has claimed its job";
  - two runners sharing one database;
  - abort on cancel.

  See [test/core/server/jobs/job-runner.integration.test.ts](https://github.com/Daanish2003/ai-chat/blob/5dea823f52bc63da61296128fdb8f1cd07aa91b2/packages/chat-sdk/test/core/server/jobs/job-runner.integration.test.ts).

### What the engines have that the runner lacks

These are facts, not a plan:

- **Step checkpoints.** All five step engines key a step row by run plus a step identity. That identity is either a call-order counter (DBOS, Workflow SDK, Hatchet) or a name with a repeat suffix (Absurd, OpenWorkflow). Each one checks on replay that the identity still matches.
- **Ownership tokens on step writes.** The runner fences only the final outcome. DBOS (`owner_xid`), Absurd (attempt), Workflow SDK (`seq_in_band`) and OpenWorkflow (`worker_id` under a row lock) also fence every step write.
- **Suspend instead of holding a slot.** Absurd, OpenWorkflow and the Workflow SDK end the invocation on sleep or wait and park the row with a wake time. DBOS keeps the workflow in memory with `setTimeout`.
- **Messages into a run** are a table row plus a wake-up (DBOS `notifications`, Absurd `e_`/`w_`, OpenWorkflow `workflow_signals`, Workflow SDK `hook_received`). In every case, consuming the message is recorded as a step.
- **Per-key concurrency** in Postgres takes one of three forms:
  - DBOS: a partition key column plus a dequeue that skips keys which already have a running row;
  - graphile-worker: a locked queue row;
  - pg-boss: partial unique indexes.

  Hatchet adds `CANCEL_IN_PROGRESS`.

- **Children** are linked both ways in the same transaction as the parent's step row (DBOS, OpenWorkflow).
- **Versioning.** Every engine either refuses mismatched history (name or hash checks) or pins runs to a version (DBOS app version, pgflow slug). DBOS alone offers in-place patching.
