# Durable execution engines behind a seam (#856)

Research for map #853. The question: can the Bot SDK's durable execution sit behind a seam with two real adapters? This compares DBOS (TypeScript), Inngest, Trigger.dev v4, Temporal's TypeScript SDK, the Workflow SDK (Vercel Workflow DevKit), Restate and pg-boss with our runner. It reports the smallest shared interface, what the Turn loop loses behind it, and whether serverless Hosts become reachable.

Read on 2026-10-25 against HEAD `57e2e4f3`. Every external claim cites the page it came from. Unverified points are marked **Unverified**. Lines marked **Inference** are my reading, not a source's words. Prior research [#408](https://github.com/Daanish2003/bot-sdk/issues/408) read the internals of DBOS, the Workflow SDK's Postgres World and pg-boss at pinned commits. This file builds on it and doesn't repeat it.

## 1. What our runner offers the plugins today

The seam has to cover what `bot` and `computer` actually call, not only the `JobRunner` type.

| Capability                                                                                                                                        | Where                                      | Used by                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.activity(name, fn)`: the JSON result is saved as a Checkpoint and replayed by call order, with a name check (`NonDeterminismError`)          | `plugins/runner/server/workflow/engine.ts` | every model and tool call in `plugins/bot/server/loop.ts`                                                                              |
| `ctx.activity(name, (tx) => …)`: `fn`'s writes commit in the same transaction as the Checkpoint, fenced to the attempt (`HistoryStore.saveWith`)  | `engine.ts`, `jobs/history.ts`             | `start_turn` and `end_turn` in `turn.ts`, SendToUser, billing (`loop.ts:400, 556, 637, 658`)                                           |
| `ctx.now()`, `ctx.random()`, `ctx.patched(id)`                                                                                                    | `engine.ts`                                | Turn code                                                                                                                              |
| `{ yields: false }` and the deploy yield (`WorkflowYieldedError`): `stop()` hands a row back `queued` at its next Checkpoint                      | `engine.ts`, `jobs/in-process.ts`          | `loop.ts` markers                                                                                                                      |
| `enqueue(name, payload, { idempotencyKey, runAfter })`                                                                                            | `jobs/runner.ts`                           | Helpers, demonstrations                                                                                                                |
| `enqueueIn(tx, …)` and `cancelIn(tx, key)`: queue or cancel a job **inside the caller's transaction**; both throw unless the runner is in-process | `plugins/runner/server/plugin.ts:84-95`    | the Router (`router.ts:79, 124`), Check-ins, Routines, Helpers, hand-off, the Computer's sleep check (`computer/server/plugin.ts:859`) |
| `cancel(key)`: drops a queued job, or aborts a running one at its next heartbeat (`signal`) or at its next fenced Checkpoint                      | `runner.ts`, `jobs/store.ts`               | user deletes and cancels                                                                                                               |
| Lanes: a separate concurrency budget for `helper` jobs                                                                                            | `jobs/define.ts`, `in-process.ts`          | Helpers (#602)                                                                                                                         |
| `onFailed`, `onCancelled` (the latter runs from the lease sweep after a crash)                                                                    | `define.ts`                                | Turn and Helper cleanup                                                                                                                |

Things that aren't in the runner:

- **One Turn per Conversation** isn't a runner feature. The Router locks the Conversation row (`lockConversation`, `router.ts:43`), queues Triggers in `bot_trigger`, and starts a Turn only when none is `running`. Ending a Turn chains the next one in the same transaction. The runner never needs per-key serialization for Turns.
- **A leak through the seam:** `jobNotStarted` (`router.ts:89`) reads `chat.job` and `chat.job_event` directly. When a Trigger joins a Turn whose job hasn't started yet, the Router cancels that job and queues a replacement in the same transaction. That is a runner internal used from the `bot` plugin.
- Both plugins refuse a non-in-process runner at start (`bot/server/plugin.ts:91`, `computer/server/plugin.ts:309`). The bot plugin's reason: "a Trigger.dev retry starts a Turn over and would send its Messages again".

## 2. The engines, per criterion

### 2.1 Durable-step model (closeness to ours)

| Engine             | Step model                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Inline closure as a step?                                                                                                                                                                                            | Where Checkpoints live                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Ours**           | call-order replay plus a name check, Temporal-style                                                                                                                                                                                                                                                                                                                                                                                                                | yes                                                                                                                                                                                                                  | `chat.job_event`, our Postgres                                                                                              |
| **DBOS**           | `DBOS.runStep(() => …, { name })`; the workflow must be deterministic and call "the same steps with the same inputs in the same order"; a mismatch throws `DBOSStepNondeterminismError` ([steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial), [workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)). `DBOS.now` and `DBOS.randomUUID` are checkpointed as steps ([methods](https://docs.dbos.dev/typescript/reference/methods)) | yes                                                                                                                                                                                                                  | the DBOS system database, Postgres ([architecture](https://docs.dbos.dev/architecture))                                     |
| **Inngest**        | `step.run` results are memoized; "code outside a step can run again each time the handler replays"; TS SDK v4 runs ordinary steps back to back in one request, and the standard mode runs each step in a separate request ([execution](https://www.inngest.com/docs/learn/how-functions-are-executed))                                                                                                                                                             | yes                                                                                                                                                                                                                  | Inngest's state store, "outside your function" ([execution](https://www.inngest.com/docs/learn/how-functions-are-executed)) |
| **Trigger.dev v4** | **no step memoization inside a task.** A retried task "starts from the beginning, but leverages cached results for completed subtasks"; waits are CRIU process snapshots ([how it works](https://trigger.dev/docs/how-it-works))                                                                                                                                                                                                                                   | no; only subtasks (`triggerAndWait`) are cached                                                                                                                                                                      | Trigger.dev's server                                                                                                        |
| **Temporal TS**    | history replay, the model we copied. Workflows run "in a deterministic sandboxed environment" and "cannot directly import the Activity Definition" ([workflow basics](https://docs.temporal.io/develop/typescript/workflows/basics))                                                                                                                                                                                                                               | **no**: activities are separately registered functions, not closures over the loop's state. **Unverified:** the `proxyActivities` details (the page doesn't cover them)                                              | the Temporal Service                                                                                                        |
| **Workflow SDK**   | `"use workflow"` / `"use step"` directives; workflow code re-runs against an event log in a sandbox where `Math.random` and `Date` are fixed; steps get 3 retries by default ([workflows and steps](https://workflow-sdk.dev/docs/foundations/workflows-and-steps))                                                                                                                                                                                                | **no** (documented): arguments and results "must be serializable" and are passed by value ([serialization](https://workflow-sdk.dev/docs/foundations/serialization)). **Unverified:** whether captured closures work | the World (local, Vercel, Postgres) ([deploying](https://workflow-sdk.dev/docs/deploying))                                  |
| **Restate**        | `ctx.run` results are recorded in the execution log for replay; `ctx.rand` and `ctx.date.now()` are stable across retries ([durable steps](https://docs.restate.dev/develop/ts/durable-steps.md))                                                                                                                                                                                                                                                                  | yes (no Restate context inside `ctx.run`)                                                                                                                                                                            | the Restate server's log ([architecture](https://docs.restate.dev/references/architecture))                                 |
| **pg-boss**        | a job queue, no steps ([README](https://github.com/timgit/pg-boss))                                                                                                                                                                                                                                                                                                                                                                                                | n/a                                                                                                                                                                                                                  | n/a                                                                                                                         |

### 2.2 Transactional steps (a write committed with its Checkpoint)

- **DBOS: yes.** Transactions "execute as a single database transaction", and the `transaction_completion` table ensures "each transaction is run exactly once". Datasources exist for Drizzle (our ORM), Knex, Kysely and node-postgres ([transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)). **Unverified:** whether a DBOS transaction can also take part in a transaction the Host opened (our `enqueueIn(tx)` case).
- **Inngest, Trigger.dev, Temporal, Restate: no.** Their Checkpoints live in their own store (cited above), so a write to the Host's Postgres can't commit atomically with one. **Inference** from where state lives; none of their pages offers it.
- **Workflow SDK Postgres World:** the events are in Postgres, but nothing documents sharing a transaction with user writes. **Unverified.**
- **pg-boss:** no steps. It can "create jobs in an existing db transaction", with adapters for Drizzle, Knex, Kysely and Prisma ([README](https://github.com/timgit/pg-boss)). That covers `enqueueIn(tx)`.

### 2.3 Cancellation and abort

| Engine       | When a cancel takes effect                                                                                                                                                                                                                                      | Running step                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Ours         | next heartbeat (`signal`), or sooner at the next fenced Checkpoint, which rolls back a `(tx)` write                                                                                                                                                             | `AbortSignal`                                                                                                  |
| DBOS         | "interrupts it at the start of its next step"                                                                                                                                                                                                                   | `DBOS.stepStatus.cancelSignal`, an AbortSignal ([methods](https://docs.dbos.dev/typescript/reference/methods)) |
| Inngest      | "If a step is already executing, that step finishes"; queued and sleeping runs stop earlier ([cancellation](https://www.inngest.com/docs/features/inngest-functions/cancellation))                                                                              | no signal documented                                                                                           |
| Trigger.dev  | `runs.cancel(runId)` "stops its task execution" and prevents retries ([runs](https://trigger.dev/docs/runs))                                                                                                                                                    | **Unverified:** whether the task gets an AbortSignal                                                           |
| Temporal     | an activity "cannot receive a cancellation request" unless it heartbeats ([cancellation](https://docs.temporal.io/develop/typescript/cancellation))                                                                                                             | an error at the next heartbeat                                                                                 |
| Workflow SDK | "at its next suspension point (step call, hook await, or sleep)"; run cancellation "does not abort `AbortSignal`s" ([cancellation](https://workflow-sdk.dev/docs/foundations/cancellation))                                                                     | runs to completion                                                                                             |
| Restate      | a `TerminalError` at the next await; a cancel during `ctx.run` throws once the block finishes ([admin API](https://docs.restate.dev/admin-api/invocation/cancel-an-invocation); **Unverified:** the SDK-side wording came through search, the guide page 404'd) | runs to completion                                                                                             |
| pg-boss      | **Unverified** (not read)                                                                                                                                                                                                                                       | —                                                                                                              |

Only DBOS and ours abort a live model call promptly through a signal. Elsewhere a long model call runs to its end and its result is dropped or recorded.

### 2.4 Per-key serialization

Not needed from the engine (section 1), but every option exists:

- DBOS partitioned queues: `partitionConcurrency` caps "workflows from any one partition running at once across all processes" ([queues](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)).
- Inngest `singleton` ("implies one active run per key") ([singleton](https://www.inngest.com/docs/guides/singleton)). `concurrency` with `limit: 1` caps steps, not runs, and "does not guarantee that whole imports run one after another" ([concurrency](https://www.inngest.com/docs/guides/concurrency)).
- Trigger.dev `concurrencyKey` ([triggering](https://trigger.dev/docs/triggering)) with `concurrency: { total: 1 }` ([queue concurrency](https://trigger.dev/docs/queue-concurrency)).
- Temporal: "at most one Workflow Execution with a given ID running at any point in time" ([workflow ID](https://docs.temporal.io/workflow-execution/workflowid-runid)).
- Restate Virtual Objects: "at most one handler with write access can run at a time per object key" ([services](https://docs.restate.dev/concepts/services)).
- pg-boss `singleton` and `key_strict_fifo` policies ([queues](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md)).
- Workflow SDK: nothing found. **Unverified.**

### 2.5 Scheduling (a delayed single job, as `runAfter` does)

All except the Workflow SDK document a delayed start:

- DBOS `delaySeconds`, plus cron schedules with optional backfill ([methods](https://docs.dbos.dev/typescript/reference/methods)).
- Inngest event `ts`, `step.sleepUntil`, and cron with a `TZ=` prefix ([scheduled functions](https://www.inngest.com/docs/guides/scheduled-functions)).
- Trigger.dev `delay` ([triggering](https://trigger.dev/docs/triggering)).
- Temporal Schedules ([schedules](https://docs.temporal.io/schedule)). **Unverified:** a start delay on a single workflow.
- Restate delayed sends ([service communication](https://docs.restate.dev/develop/ts/service-communication.md)); no cron on that page.
- pg-boss deferral and cron ([README](https://github.com/timgit/pg-boss)).
- Workflow SDK: `sleep()` inside a workflow ([workflows and steps](https://workflow-sdk.dev/docs/foundations/workflows-and-steps)). **Unverified:** a delayed start.

Our Routines already self-chain with `runAfter` (ADR 0011), so a delayed `enqueue` is all the seam needs.

### 2.6 Self-hosting on Postgres only

| Engine                      | Postgres only?                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DBOS                        | **Yes**: "no infrastructure required besides Postgres" ([architecture](https://docs.dbos.dev/architecture)). But recovering a dead process's workflows needs coordination, "automatic through Conductor or manual" (same page). #408 found no lease in the open-source code. |
| pg-boss                     | **Yes**, Postgres 13+ ([README](https://github.com/timgit/pg-boss))                                                                                                                                                                                                          |
| Workflow SDK Postgres World | **Yes** (Postgres plus graphile-worker). It is a reference world "not optimized for scale, speed, or security", with no auth on its HTTP routes, and it needs a long-lived worker ([Postgres World](https://workflow-sdk.dev/docs/deploying/world/postgres-world))           |
| Temporal                    | No: the Temporal Service plus Postgres. Postgres alone suffices for visibility ([visibility](https://docs.temporal.io/self-hosted-guide/visibility))                                                                                                                         |
| Inngest                     | No: one binary with Postgres via `postgres-uri`, and Redis for "the queue and state store", in-memory by default ([self-hosting](https://www.inngest.com/docs/self-hosting)). **Unverified:** how durable the in-memory Redis is                                             |
| Trigger.dev                 | No: a set of containers including Redis; "Checkpoints are only available on Trigger.dev Cloud" ([self-hosting](https://trigger.dev/docs/self-hosting/overview))                                                                                                              |
| Restate                     | No: its own log, RocksDB and S3 snapshots; Postgres isn't used ([architecture](https://docs.restate.dev/references/architecture))                                                                                                                                            |

### 2.7 Running serverless

| Engine       | Serverless worker?                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inngest      | **Yes, natively**: steps run as requests to your app ([execution](https://www.inngest.com/docs/learn/how-functions-are-executed))                                                                                                                                                       |
| Restate      | **Yes**: Lambda, Vercel, Cloudflare Workers and Deno Deploy are listed deploy targets ([Lambda](https://docs.restate.dev/services/deploy/lambda), [Vercel](https://docs.restate.dev/services/deploy/vercel.md), [Workers](https://docs.restate.dev/services/deploy/cloudflare-workers)) |
| Workflow SDK | **Only on the Vercel World**; the Postgres World "does not work on serverless platforms" ([Postgres World](https://workflow-sdk.dev/docs/deploying/world/postgres-world))                                                                                                               |
| DBOS         | **Partly**: a worker in a Vercel Function started by a cron (once a minute recommended); unfinished workflows are recovered "when the worker next starts" ([Vercel](https://docs.dbos.dev/integrations/vercel))                                                                         |
| Temporal     | Serverless Workers for Lambda and Cloud Run are in Public Preview ([serverless workers](https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers)). **Unverified:** TypeScript support and self-hosted use                                                  |
| Trigger.dev  | Tasks run on Trigger.dev's workers; a serverless app only triggers them ([triggering](https://trigger.dev/docs/triggering))                                                                                                                                                             |
| pg-boss      | "Serverless function compatible" for sending ([README](https://github.com/timgit/pg-boss)); workers poll                                                                                                                                                                                |

## 3. The smallest interface two or more can satisfy

**Inference** from section 2. The `JobRunner` type isn't the real seam; the real one is the runner plus `WorkflowContext` plus `enqueueIn`/`cancelIn`. Splitting it into two ports gives each port several adapters.

**Port A, durable step context** (what a job handler gets):

```ts
type DurableContext = {
  step<T>(name: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T>; // JSON result, replayed
  now(): Promise<Date>; // may be a step
  random(): Promise<number>; // may be a step
  signal: AbortSignal; // best effort: prompt in ours and DBOS, end-of-step elsewhere
};
```

An inline-closure `step(name, fn)` replayed by call order fits **ours, DBOS, Inngest and Restate**. Temporal and the Workflow SDK need activities written as separate, registered or serializable functions, which means rewriting `loop.ts`. `patched` maps onto DBOS's patch (#408) and Temporal's `patched`, but not cleanly onto the others. **Unverified:** Inngest's and Restate's versioning.

**Port B, dispatch** (how work gets queued):

```ts
type Dispatch = {
  enqueue(name: string, payload: unknown, o?: { key?: string; runAfter?: Date }): Promise<string>;
  cancel(key: string): Promise<void>;
};
```

Every engine here satisfies Port B, pg-boss and Trigger.dev included.

**Inference, the useful consequence:** our engine (`createWorkflow` plus a `HistoryStore` in our Postgres) can run **on top of any Port B adapter**. A Trigger.dev task or a pg-boss worker can call a `runJob` that replays from `chat.job_event` keyed by our own job id. Today it uses `unrecordedStore`, which records nothing. Checkpoints and `(tx)` activities then stay ours even on Trigger.dev or pg-boss. The open problem is the fence: `saveWith` fences on our lease (`ownAttempt`), so an external queue would need either an attempt token it guarantees is unique per running attempt or a lease we keep ourselves. **Unverified** for each engine.

## 4. What the Turn loop loses behind a portable seam

Against Port A on Inngest, Restate or Temporal, which DBOS largely keeps:

1. **Exactly-once writes with the Checkpoint** (SendToUser, billing, `start_turn`, `end_turn`). Behind the seam these become at-least-once, so each write needs its own idempotency key, for example a unique `(turn_id, seq)` on the Message and usage rows, to stay effectively once. DBOS keeps this through datasource transactions.
2. **Transactional enqueue and cancel** (`enqueueIn(tx)`, `cancelIn(tx)`) used by the Router, Routines, Check-ins, Helpers and the Computer's sleep check. With an external engine they need an outbox table and a relay after commit. pg-boss, and our in-process runner, keep them.
3. **The Router's "replace a job that hasn't started"** (`jobNotStarted` reads `chat.job` and `chat.job_event`). It must become a port method (`reschedule(key, runAfter)` if not started) or Router state of its own. Inngest's debounce or singleton may cover it. **Unverified.**
4. **Prompt abort of a live model call on cancel.** Only DBOS has a signal for a running step. Elsewhere a cancelled Turn's in-flight model call runs on.
5. **The deploy yield** (`yields`, `WorkflowYieldedError`, handing back uncounted). External engines recover in their own way, so it becomes adapter-internal and drops out of the interface.
6. **Lanes, `onCancelled` from the lease sweep, the attempt cap and our backoff.** These map to per-engine queue and concurrency config and failure hooks, with different retry semantics. Inngest and Restate retry per step, while we retry the job and replay.
7. **Payload and history limits.** A model step records every chunk. Temporal errors at 2 MB per payload and at 50 MB or 51,200 events of history ([defaults](https://docs.temporal.io/self-hosted-guide/defaults)). **Unverified:** the equivalent limits for Inngest and Restate.

## 5. Do serverless Hosts become reachable?

**Inference:** yes, but only through Inngest or Restate (or the Workflow SDK on Vercel), and only after items 1 to 3 of section 4: idempotent writes in place of `(tx)` activities, an outbox in place of `enqueueIn(tx)`, and a port method in place of `jobNotStarted`. Without those, a retried step can send a Message twice, which is exactly why `bot` refuses Trigger.dev today. DBOS on Vercel only works with a cron-started worker and recovery on its next start. A single model step must also fit the function's duration limit. The 5-minute Turn limit suggests it would. **Unverified:** each platform's step timeout. A Postgres-only second adapter is easiest as **DBOS** (the same model, transactions, partition queues, Postgres only, but recovering a dead process needs Conductor or our own sweep) or **pg-boss as Port B under our own engine**.

## Unverified, collected

- Whether a DBOS transaction can join a transaction the Host opened.
- Trigger.dev: whether a running task gets an AbortSignal on cancel.
- Restate: the exact cancel semantics on the SDK side (the guide page 404'd; search summary only); versioning.
- The Workflow SDK: closures as steps, per-key concurrency, delayed start, transactional writes on the Postgres World.
- Inngest: how durable the self-hosted in-memory Redis is; versioning; payload limits.
- Temporal: TypeScript on Serverless Workers; `proxyActivities` details; a start delay.
- pg-boss: cancel semantics for an active job.
- Whether any external queue offers an attempt token unique enough for our `HistoryStore` fence.
