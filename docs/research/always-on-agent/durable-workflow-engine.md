# Durable workflow engine for the runner SDK

Research for issue #386 (child of the map #383). Researched on 2026-10-16.

**Question.** What durable-workflow engines could back the durable runner SDK? Temporal is the lecture's choice and the default candidate. It is compared here with Workflow SDK (formerly Workflow DevKit), Trigger.dev v4, Inngest, DBOS, Restate, Hatchet, and extending the in-house Postgres runner ([ADR 0011](../../adr/0011-background-jobs-through-durable-runner.md), `packages/chat-sdk/core/server/jobs/`). For each engine: step replay, signals and cancellation, timers and cron, child workflows, TypeScript SDK, self-hosting next to Render ([ADR 0009](../../adr/0009-production-on-render.md), proposed), licence, and whether it fits behind a copied, stack-agnostic SDK interface ([ADR 0005](../../adr/0005-copied-stack-agnostic-chat-sdk.md)).

**Facts only.** This file doesn't pick an engine; the design ticket will.

**Method.** Sources are official docs, GitHub repos and LICENSE files, the npm registry (`registry.npmjs.org/<pkg>`) and pricing pages. Versions are as of 2026-10-16. Some statements are my inferences; they are labelled _(inference)_. Anything I couldn't confirm is labelled **unverified**.

---

## What the agent needs from the engine

These requirements come from the lecture write-up in #383:

- **One turn at a time per conversation.** A Run is "loads state, works, saves each step".
- **A user's message "skips the line".** It interrupts the turn that is running.
- **Routines and scheduled check-ins.** Both need cron or timers.
- **Helpers.** Each Helper runs as its own durable child workflow.
- **One service.** Everything has to run beside a single Docker web service on Render, with Render Postgres and Render Key Value (Redis).

## Summary table

| Engine                        | Durability model                                                                                                       | Message in / interrupt                                                                                                                 | Timers / cron                                                                       | Children                                                      | Extra infra on Render                                                                                                                                         | Server licence                                           | SDK licence |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------- |
| **Temporal**                  | Event-history replay of the whole function, run in a deterministic sandbox                                             | Signals, Updates, Queries; `CancellationScope` cancels activities, timers and children; activities see a cancel only if they heartbeat | Durable `sleep`; Schedules API (cron is legacy)                                     | `startChild` / `executeChild`, `parentClosePolicy`            | Temporal cluster (several services + Postgres 13–16 + optional Elasticsearch), or Temporal Cloud                                                              | MIT                                                      | MIT         |
| **Restate**                   | Journaled steps (`ctx.run`), replayed by the server                                                                    | Signals, awakeables, workflow promises; Virtual Objects run one writer per key; cancel lands at the next await                         | Durable `ctx.sleep`, delayed sends; **no native cron**                              | Service, object or workflow calls (`ctx.*Client`), `ctx.send` | Restate server (one Rust binary on a persistent disk); uses neither Postgres nor Redis                                                                        | BUSL-1.1 (each version becomes Apache-2.0 after 4 years) | MIT         |
| **Hatchet**                   | Durable tasks checkpoint at waits and spawns, and replay the event log                                                 | `waitForEvent` (key + CEL), `runs.cancel`; `ctx.abortController.signal`; `CANCEL_IN_PROGRESS` concurrency strategy                     | `sleepFor` / `sleepUntil`; cron built in                                            | `spawnChild` / `spawnChildren`                                | Hatchet engine (Hatchet Lite: one image on Postgres, "low-volume")                                                                                            | MIT                                                      | MIT         |
| **Inngest**                   | Memoized steps; the handler replays, and finished steps return saved results                                           | `waitForEvent`, `waitForSignal`, `cancelOn`, singleton `cancel` mode; cancel lands **between steps** only                              | `step.sleep` / `sleepUntil`; cron triggers (declared in config)                     | `step.invoke`                                                 | Inngest server (one image + Postgres + Redis)                                                                                                                 | SSPL-1.0, with Apache-2.0 3 years after release          | Apache-2.0  |
| **Trigger.dev v4**            | Not step replay: a CRIU checkpoint while waiting (Cloud only); a failed run restarts and reuses cached subtask results | Wait tokens, input streams (`.on()` can abort a running `streamText`), `runs.cancel` with `signal`                                     | `wait.for` / `until`; declarative and imperative `schedules.create`                 | `triggerAndWait`, `batchTriggerAndWait`                       | Self-hosting needs webapp, supervisor, Postgres, Redis, ClickHouse, S2, a registry and object storage, plus Docker for workers; in practice Trigger.dev Cloud | Apache-2.0                                               | MIT         |
| **Workflow SDK** (`workflow`) | Event-sourced replay of a sandboxed workflow body; `"use step"` results cached                                         | `createHook` / `resumeHook` (reusable, deterministic tokens); `run.cancel()` at the next suspension point                              | Durable `sleep`; **no cron**                                                        | `start()` inside a workflow + `await run.returnValue`         | None with the Postgres World (runs in-process on Postgres; graphile-worker)                                                                                   | Apache-2.0                                               | Apache-2.0  |
| **DBOS Transact**             | Checkpointed steps in Postgres; the workflow re-runs and completed steps are skipped                                   | `send` / `recv`, `setEvent` / `getEvent`, streams; `cancelWorkflow` preempts at the next step, and a step sees `cancelSignal`          | `DBOS.sleep`; DB-stored cron schedules created at runtime                           | `startWorkflow` + handle, `cancelChildren`                    | None (a library inside the app process on Render Postgres); optional paid Conductor                                                                           | MIT (library)                                            | MIT         |
| **In-house runner** (today)   | **None at step level**: a job retries whole, under a lease                                                             | `cancel(idempotencyKey)` aborts at the next heartbeat (≤10 s); no messages into a running job                                          | `schedule({ everyMs })` designed, throws "not supported yet"; `runAfter` for delays | None                                                          | None (Postgres only)                                                                                                                                          | Ours                                                     | Ours        |

---

## Temporal (TypeScript SDK)

- **Replay.**
  - The server records every command result as Events. After a crash a worker fetches the history and re-runs the workflow function from the start, so "resume at step 3" means steps 1–2 replay their recorded results and step 3 is scheduled for real.
  - A dead worker is detected by the Workflow Task Timeout, 10 s by default. https://docs.temporal.io/encyclopedia/event-history/event-history-typescript
  - Workflow code runs in a deterministic sandbox: `Math.random`, `Date` and `setTimeout` are replaced. It can't import modules that use Node or DOM APIs, and it can't import activity implementations. All I/O goes through Activities. https://docs.temporal.io/develop/typescript/workflows/basics
- **Messages and cancellation.**
  - Three message types: Signals (async), Updates (sync, validated, return a result) and Queries (read-only). `condition()` waits on a predicate, and the client has `signalWithStart`. https://docs.temporal.io/develop/typescript/message-passing
  - `CancellationScope` is a tree. `scope.cancel()` cancels the activities, timers and children inside it, and `nonCancellable` scopes are for cleanup. https://typescript.temporal.io/api/classes/workflow.CancellationScope
  - An Activity only learns of a cancel if it heartbeats. The `cancellationType` options are TRY_CANCEL (default), WAIT_CANCELLATION_COMPLETED and ABANDON. https://docs.temporal.io/develop/typescript/cancellation
  - _(Inference)_ A Signal or Update handler cancelling the scope that runs the turn would give "skip the line".
- **Timers and cron.**
  - Timers are durable: a workflow "can sleep for months", and a single Worker can hold millions of them. https://docs.temporal.io/develop/typescript/timers
  - The Schedules API supports interval and calendar specs, overlap policy, pause, backfill and trigger. `cronSchedule` still exists, but Temporal recommends Schedules. https://docs.temporal.io/develop/typescript/schedules
- **Children.** `startChild` returns a handle (signal, cancel, `result()`), and `executeChild` starts a child and awaits it. `parentClosePolicy` defaults to TERMINATE. https://docs.temporal.io/develop/typescript/child-workflows
- **SDK.**
  - `@temporalio/{client,worker,workflow,activity}` 1.24.0, published 2026-09-15, Node ≥ 20.3.0. https://registry.npmjs.org/@temporalio/worker
  - The worker depends on webpack, `@swc/core` and a native Rust addon (`@temporalio/core-bridge`). Workflow code is bundled with webpack when the worker starts, or ahead of time with `bundleWorkflowCode`. https://docs.temporal.io/develop/typescript/workers/run-worker-process
  - Bun support is experimental. Release notes mention friction with pnpm's non-hoisted layouts (v1.20.3). https://github.com/temporalio/sdk-typescript/releases
- **Self-hosting.**
  - Server v1.32.1 (2026-10-08), image `temporalio/server`. Schema migrations are run with `temporalio/admin-tools`. https://docs.temporal.io/self-hosted-guide/deployment
  - Persistence can be PostgreSQL 13–16, MySQL or Cassandra, or SQLite for dev. https://docs.temporal.io/temporal-service/persistence
  - Visibility can use Postgres 12+ or Elasticsearch/OpenSearch. https://docs.temporal.io/self-hosted-guide/visibility
  - No Redis is needed. **Unverified:** whether it supports Postgres 17 or 18.
  - Render publishes an official guide and template. It runs frontend, history, matching, worker and UI as private services, plus Postgres and Elasticsearch, and there is a "simple" single-service variant that isn't for production. https://render.com/docs/deploy-temporal, https://github.com/render-examples/temporal, https://github.com/temporalio/temporal-render-simple
  - **Unverified:** resource needs.
  - Temporal Cloud is pay-as-you-go from $50 per million actions, with $150 of credits for 90 days and no permanent free tier. https://temporal.io/pricing
- **Licence.** MIT for both server and SDK.
- **Fit behind a copied interface.**
  - The worker is a long-lived gRPC poller. The docs don't forbid running it inside the web process.
  - The sandbox, webpack bundling and the native addon shape the code layout: workflow files must be separate from activity files and can't import Node.
  - enqueue, signal, cancel and schedule each map onto a client call.

## Restate (TypeScript SDK)

- **Replay.**
  - Each context action (`ctx.run`, calls, sleeps, state) is written to a journal. On retry the server re-invokes the handler and replays the journal, so completed steps are skipped. https://docs.restate.dev/concepts/durable_execution
  - Non-deterministic work goes inside `ctx.run`. Use `ctx.rand` and `ctx.date` for randomness and time. https://docs.restate.dev/develop/ts/journaling-results
- **Messages and cancellation.**
  - There are three ways in: Signals (by invocation id and name), awakeables (one-shot, resolvable over HTTP) and workflow promises. https://docs.restate.dev/develop/ts/external-events
  - Virtual Objects allow "at most one handler with write access … per object key", so a new message queues behind the running turn. https://docs.restate.dev/foundations/services
  - Cancel through the admin API (`PATCH /invocations/{id}/cancel`) or `ctx.cancel(invocationId)`. It surfaces as a `TerminalError` at the next await and spreads to callees that were awaited, but not to detached sends. Kill skips compensation. https://docs.restate.dev/services/invocation/managing-invocations, https://docs.restate.dev/develop/ts/service-communication
- **Timers and cron.** `ctx.sleep` and delayed sends are durable. "Restate does not yet include native cron support": cron is built from timers and a loop that reschedules itself. https://docs.restate.dev/develop/ts/durable-timers
- **Children.** There's no separate child-workflow concept. A child is a call to another service, object or workflow, awaited, sent with `ctx.send`, or re-attached later with `ctx.attach`. https://docs.restate.dev/develop/ts/service-communication
- **SDK.**
  - `@restatedev/restate-sdk` 1.17.3 (2026-10-09). The docs list Node 22+, Bun and Deno, and no bundling is needed. https://registry.npmjs.org/@restatedev/restate-sdk, https://docs.restate.dev/develop/ts/overview
  - It is served with `restate.serve` (HTTP/2) or with `createEndpointHandler` mounted in a Node `http`/`http2` server. Over HTTP/1.1 each request ends at a suspension point. https://docs.restate.dev/develop/ts/serving
- **Self-hosting.**
  - One Rust binary or image. Storage is embedded (a log, RocksDB and Raft metadata), so it needs a persistent volume, and a cluster needs S3 for snapshots. It doesn't use Postgres or Redis. https://docs.restate.dev/server/deploy/docker, https://docs.restate.dev/server/overview
  - Server v1.8.0 (2026-10-14).
  - On Render it would be a private service with a disk _(inference; no Render guide exists)_.
  - Restate Cloud's free plan gives 100k actions a month. **Unverified:** paid prices. https://restate.dev/pricing
- **Licence.** The server is BUSL-1.1. Running it for your own services is allowed, offering it as a public "Restate Platform Service" isn't, and each version becomes Apache-2.0 after 4 years. https://github.com/restatedev/restate/blob/main/LICENSE. The SDK is MIT.
- **Fit.**
  - It's a push model: the server calls an HTTP endpoint that can live inside the web process. That endpoint has to be registered with the server.
  - An adapter would have to add "cancel the current turn on a new message" and cron.

## Hatchet (TypeScript SDK)

- **Replay.**
  - Durable tasks write a checkpoint at each sleep, event wait or child spawn. On resume Hatchet "replays the durable event log". It doesn't re-execute completed operations, but it does re-run the code path that led to each checkpoint. https://docs.hatchet.run/v1/durable-tasks
  - Durable tasks may only call durable-context methods or spawn children, so side effects move into child tasks.
  - A waiting task can be evicted from its worker slot. https://docs.hatchet.run/v1/task-eviction
  - Delivery is at-least-once. https://docs.hatchet.run/home/architecture
- **Messages and cancellation.**
  - `waitFor` / `waitForEvent(key, CEL expression)`, with `hatchet.events.push(key, payload, { scope })` to send. There's no "signal this run id". https://docs.hatchet.run/reference/typescript/context, https://docs.hatchet.run/home/durable-events
  - Cancel with `hatchet.runs.cancel`. A running task sees `ctx.cancelled` and `ctx.abortController.signal`. The `CANCEL_IN_PROGRESS` concurrency strategy cancels running instances once a key hits its limit. https://docs.hatchet.run/home/cancellation
  - _(Inference)_ A concurrency key per conversation would let a new message cancel the turn in flight.
- **Timers and cron.** `sleepFor` / `sleepUntil`, `workflow.cron()` / `hatchet.crons.create`, and one-off `schedule`. https://docs.hatchet.run/reference/typescript/feature-clients/crons
- **Children.** `spawnChild` / `spawnChildren`, awaited. https://docs.hatchet.run/home/child-spawning. **Unverified:** what happens to children when the parent is cancelled.
- **SDK.** `@hatchet-dev/typescript-sdk` 1.38.0 (2026-10-13), Node ≥ 20. Its dependencies are pure JS (gRPC); there's no bundler and no native addon. https://registry.npmjs.org/@hatchet-dev/typescript-sdk
- **Self-hosting.**
  - The full setup is an API server, the engine, Postgres, optional RabbitMQ and a dashboard. https://docs.hatchet.run/self-hosting
  - **Hatchet Lite** is one image that needs only `DATABASE_URL`, but it is "designed for development and low-volume use-cases". https://docs.hatchet.run/self-hosting/hatchet-lite
  - Engine v0.110.5 (2026-10-06), so pre-1.0.
  - **Unverified:** running Lite on Render, including its gRPC port 7077.
  - Cloud has a $0 base with 1M task runs a month, then $30 per million. https://hatchet.run/pricing
- **Licence.** MIT for both server and SDK.
- **Fit.**
  - The worker is a long-running process with a bidirectional gRPC connection to the engine. **Unverified:** running it inside the web process as a supported pattern.
  - Messages addressed by event key don't map one-to-one onto a run id.

## Inngest

- **Replay.**
  - Each completed step's result is saved. The handler replays and finished steps return their saved results, so only the failed step runs again.
  - In SDK v4 steps run back to back inside one request by default ("checkpointing"). Code outside steps re-runs on every replay, and there's no sandbox. https://www.inngest.com/docs/learn/how-functions-are-executed
  - Limits: 1,000 steps per function, 4 MiB per step, 32 MiB of state per run, and 2 h per step. https://www.inngest.com/docs/usage-limits/inngest
- **Messages and cancellation.**
  - `step.waitForEvent` matches with `match` or CEL. https://www.inngest.com/docs/reference/typescript/functions/step-wait-for-event
  - `step.waitForSignal` / `sendSignal`, with an optional `'replace'` mode. https://www.inngest.com/docs/reference/typescript/functions/step-wait-for-signal
  - `cancelOn` events take effect "between steps"; it "cannot interrupt a `step.run` that has already begun". https://www.inngest.com/docs/features/inngest-functions/cancellation/cancel-on-events
  - Singleton `cancel` mode, with a key per conversation, cancels the active run and starts the new one, but a `step.run` that is already executing finishes first. https://www.inngest.com/docs/guides/singleton
  - Concurrency keys limit executing steps, not runs. https://www.inngest.com/docs/guides/concurrency
  - REST cancellation is documented for Cloud. https://www.inngest.com/docs/guides/cancel-running-functions. **Unverified:** whether it exists when self-hosted.
- **Timers and cron.**
  - `step.sleep` / `sleepUntil` (up to 1 year) and cron triggers declared in function config. https://www.inngest.com/docs/guides/scheduled-functions
  - **Unverified:** an imperative per-user schedule API.
- **Children.** `step.invoke` resolves with the child's return value. If it times out, the child keeps running. https://www.inngest.com/docs/reference/typescript/functions/step-invoke
- **SDK.**
  - `inngest` 4.24.0 (2026-10-14), Node ≥ 20, plain TS.
  - `serve()` adapters exist for Express, Hono, H3, Nitro, TanStack Start and others. `connect()` gives an outbound WebSocket worker instead. https://www.inngest.com/docs/learn/serving-inngest-functions
- **Self-hosting.**
  - The `inngest/inngest` image (server v1.46.0, 2026-10-06) runs with `--postgres-uri` and `--redis-uri`. Old rows aren't pruned automatically. https://www.inngest.com/docs/self-hosting
  - **Unverified:** compatibility with Render Key Value (Valkey).
  - Cloud Free gives 50k executions a month, 5 concurrent steps, and pauses at the quota. Pro is from $99 a month. https://www.inngest.com/pricing
- **Licence.**
  - Server: SSPL-1.0, with a grant of Apache-2.0 on the third anniversary of each release. https://raw.githubusercontent.com/inngest/inngest/main/LICENSE.md
  - SDK: Apache-2.0. https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/LICENSE.md
- **Fit.**
  - Functions run in the app process behind an HTTP endpoint, with the Inngest server as a second service.
  - Cancellation and concurrency are declared statically in function config, as CEL.

## Trigger.dev v4

- **Durability.**
  - Not step replay. While a run waits, Cloud takes a CRIU checkpoint of the process and restores it later (only for waits of 60 s or more).
  - On failure a task restarts "from the beginning", but subtasks with idempotency keys return cached results. https://trigger.dev/docs/how-it-works
  - Self-hosted Trigger.dev has "No checkpoint support". https://trigger.dev/docs/self-hosting/docker
- **Messages and cancellation.**
  - Wait tokens: `wait.createToken` / `forToken` / `completeToken`, or an HTTP POST to the token's URL. https://trigger.dev/docs/wait-for-token
  - Input streams (SDK ≥ 4.4.2): `streams.input`, `stream.send(runId, data)`, and `.wait/.once/.on/.peek`. The docs show `.on()` driving an `AbortController` that stops a running `streamText`, so the interrupt lands mid-step. https://trigger.dev/docs/tasks/streams
  - `runs.cancel(runId)`. https://trigger.dev/docs/management/runs/cancel. The run receives a `signal`, and `onCancel` gets 30 s. Those last two details come from search summaries of the task docs, not fetched pages.
  - A built-in `chat.agent()` keeps one long-lived task per `chatId`. https://trigger.dev/docs/ai-chat/overview. **Unverified:** how it works, and its status.
  - Concurrency keys. https://trigger.dev/docs/queue-concurrency. **Unverified:** a true singleton mode.
- **Timers and cron.** `wait.for` / `until`. Schedules can be declarative or created at runtime per user with `schedules.create({ externalId, deduplicationKey })`. On the free plan schedules can run at most hourly. https://trigger.dev/docs/wait-for, https://trigger.dev/docs/tasks/scheduled
- **Children.** `triggerAndWait` (not inside `Promise.all`) and `batchTriggerAndWait`. https://trigger.dev/docs/triggering
- **SDK.**
  - `@trigger.dev/sdk` 4.7.4 (2026-10-14), Node ≥ 18.20.
  - Needs `trigger.config.ts`, and tasks are built and deployed with the `trigger deploy` CLI. https://trigger.dev/docs/config/config-file, https://trigger.dev/docs/cli-deploy
- **Self-hosting.**
  - Components: webapp, supervisor, Postgres, Redis, ClickHouse, S2, a registry and object storage.
  - Minimum machines are 3 vCPU / 6 GB for the webapp and 4 vCPU / 8 GB for a worker. Workers start containers through Docker.
  - The docs say self-hosting this way "is unlikely to result in a production-ready deployment". https://trigger.dev/docs/self-hosting/docker
  - _(Inference)_ Not viable on a Render web service, because workers need Docker.
  - Cloud: Free ($5 of credit), Hobby $10 a month, Pro $50 a month, plus compute. https://trigger.dev/pricing
- **Licence.** The repo is Apache-2.0 (https://raw.githubusercontent.com/triggerdotdev/trigger.dev/main/LICENSE). The npm SDK is MIT.
- **Fit.**
  - Tasks never run in the app process; they run in a separately built and deployed worker.
  - It's already the optional Host-owned adapter in ADR 0011 (`extras/trigger/`).

## Workflow SDK (formerly Workflow DevKit; `workflow`)

- **Replay.**
  - Event-sourced. The workflow body runs in a Node VM sandbox, with seeded `Math.random`/`Date` and no Node APIs, and it replays against cached step results. Steps run with full Node. https://workflow-sdk.dev/docs/how-it-works/understanding-directives
  - On Vercel: 10k steps and 25k events per run, and 240 s maximum replay. https://vercel.com/docs/workflows/pricing
- **Messages and cancellation.**
  - `createHook` with a deterministic, reusable token (`for await` over many `resumeHook` calls). `defineHook` validates payloads, and `createWebhook` exposes a webhook. https://workflow-sdk.dev/docs/foundations/hooks
  - `run.cancel()` stops a run "at the next suspension point"; steps that are already running finish. https://workflow-sdk.dev/docs/foundations/cancellation
  - No concurrency keys and no singleton. https://workflow-sdk.dev/docs/comparisons/workflow-sdk-vs-trigger-dev
  - `start()` has no idempotency key. https://workflow-sdk.dev/docs/api-reference/workflow-api/start
- **Timers and cron.** `sleep` uses no compute. There's no cron: you call `start()` from an outside cron. https://workflow-sdk.dev/docs/api-reference/workflow/sleep
- **Children.** Call `start()` inside a workflow, then `await run.returnValue`. The await polls every second. https://workflow-sdk.dev/docs/foundations/starting-workflows
- **SDK.**
  - `workflow` 5.2.2 (2026-10-13), and `@workflow/world-postgres` 5.0.4.
  - Needs an SWC compiler plugin, with entry points `workflow/vite`, `/nitro`, `/next` and others. TanStack Start, which this app uses, goes through `workflow/vite`. https://workflow-sdk.dev/docs/getting-started/tanstack-start
  - Express and Hono need Nitro as their build. **Unverified:** plain Node with no bundler.
- **Self-hosting.**
  - The Postgres World needs only Postgres (graphile-worker and LISTEN/NOTIFY). `world.start()` runs a poller inside the server and "does not work on serverless".
  - It is a "reference implementation … not optimized for scale, speed, or security": the flow route has no auth. https://workflow-sdk.dev/docs/deploying/world/postgres-world
- **Licence.** Apache-2.0. https://raw.githubusercontent.com/vercel/workflow/main/LICENSE.md
- **Fit.**
  - Runs in-process on Render Postgres.
  - The directives need the compiler in every Host's bundler, so the code is not plain TS that a copy works with as-is.
  - No cron, singleton or concurrency keys, so those must be built yourself.

## DBOS Transact (`@dbos-inc/dbos-sdk`)

- **Replay.**
  - Each step's result is checkpointed in Postgres, and an interrupted workflow "resumes execution from the last completed step". A step never re-runs once it has completed.
  - Determinism: the same inputs must invoke the same steps in the same order, otherwise it throws `DBOSStepNondeterminismError`. The docs advise against `Promise.all` over steps. https://docs.dbos.dev/typescript/tutorials/workflow-tutorial
- **Recovery across processes and deploys.**
  - A restart recovers `PENDING` workflows, but only those tagged with the same `executorID`. Another instance takes over a dead executor's work only manually or through Conductor. https://docs.dbos.dev/production/workflow-recovery
  - Workflows are also tagged with an application version, which is a hash of the code by default. Recovery only picks up a matching version, so a deploy needs a pinned `applicationVersion` or patching (`DBOS.patch`). https://docs.dbos.dev/typescript/tutorials/upgrading-workflows (from a search summary).
- **Messages and cancellation.**
  - `send` / `recv` (messages persist and can be topic-scoped), `setEvent` / `getEvent`, and streams. https://docs.dbos.dev/typescript/tutorials/workflow-communication
  - `cancelWorkflow` preempts at the next step, with `cancelChildren` to cascade. A running step sees it through `DBOS.stepStatus.cancelSignal` (an AbortSignal).
  - `resumeWorkflow` and `forkWorkflow` restart from a step. https://docs.dbos.dev/typescript/tutorials/workflow-management
- **Timers and cron.**
  - `DBOS.sleep` is durable.
  - Cron schedules live in the database. Create them with `DBOS.createSchedule` / `applySchedules` (node-cron syntax, with a timezone). Each tick runs exactly once, and many schedules can be made per entity. https://docs.dbos.dev/typescript/tutorials/scheduled-workflows
- **Children and queues.**
  - `DBOS.startWorkflow` returns a handle. A workflow ID works as an idempotency key.
  - Queues support concurrency, rate limits, **partition keys** (for example one at a time per conversation), priority and dedup. https://docs.dbos.dev/typescript/tutorials/queue-tutorial
- **SDK.**
  - 5.3.0 (2026-10-15), Node ≥ 20.
  - Workflows can be registered with the functional `registerWorkflow` or with decorators.
  - Runs inside the app: `DBOS.launch()` is called before serving. It takes an existing `pg` pool (`systemDatabasePool`) and a schema (`systemDatabaseSchemaName`, `dbos` by default). https://docs.dbos.dev/typescript/integrating-dbos, https://docs.dbos.dev/typescript/reference/configuration
  - It **can't be bundled**; it has to stay external.
  - 5.0 had breaking changes, and 4.x can't process workflows that 5.0 created. https://docs.dbos.dev/typescript/upgrading
- **Self-hosting.**
  - The library is "free forever" and needs only Postgres.
  - Conductor is optional: Pro is $99 a month for 1M checkpoints, Teams $499 a month. https://www.dbos.dev/pricing
  - Self-hosted Conductor needs a proprietary licence key (from search summaries of the DBOS FAQ).
- **Licence.** MIT.
- **Fit.**
  - `DBOS` is a process-wide static, so an adapter must own `launch()`.
  - All workflows must be registered before launch, so the adapter would register a fixed set of generic workflows.
  - The determinism rules reach the code an adapter wraps.

## Extending the in-house runner (ADR 0011)

What it does today (`packages/chat-sdk/core/server/jobs/`):

- **The interface.** `JobRunner` exposes `enqueue(name, payload, { idempotencyKey, runAfter })`, `cancel(idempotencyKey)`, `status`, `schedule(name, { everyMs })`, `start` and `stop` (`runner.ts`).
- **How jobs run.**
  - The runner polls one `chat.job` table every 2 s, claims jobs with `FOR UPDATE SKIP LOCKED`, and runs 2 jobs per process at once (`in-process.ts`).
  - A job holds a 60 s lease and heartbeats every 10 s. An attempt can run for at most 15 minutes. There are 3 attempts, with backoff of about 10 s, 1 min and 5 min (`define.ts`).
  - Cancel aborts a running job at its next heartbeat.
- **Durability.** Not at step level: a job that was reaped runs again from the start. Each job type must be safe to retry (ADR 0011).
- **Gaps.** No messages into a running job, no durable sleep, no children, and `schedule()` throws `"Recurring jobs are not supported yet"`.
- **Licence and infra.** Ours, Postgres only, copied with the SDK. It already fits ADR 0005.
- **What adding step durability would look like.**
  - Two MIT/Apache Postgres-only libraries show the shape: Absurd (below), which is closest to today's lease model, and DBOS, whose step, message, sleep and queue primitives are listed above.
  - A version of this runner would need a step-checkpoint table, waits that persist (sleep and wait-for-message), child links and cron. _(Inference.)_

Reference Postgres libraries:

- **Absurd (`absurd-sdk`, Earendil).**
  - 0.5.0 (2026-08-04), Apache-2.0, pre-1.0.
  - One `absurd.sql` file of stored functions plus a polling worker.
  - `ctx.step` checkpoints, `sleepFor` / `sleepUntil`, `awaitEvent` / `emitEvent`, `cancelTask`, idempotency keys, a claim timeout (lease), and an existing `pg.Pool`. No cron.
  - https://github.com/earendil-works/absurd, https://registry.npmjs.org/absurd-sdk
- **pg-boss.**
  - 12.38.0 (2026-10-13), MIT.
  - A queue with retries, cron, deferral and pub/sub. No step replay or wait-for-event is documented on its homepage.
  - https://pgboss.io/
- **Graphile Worker.**
  - 0.18.0 (2026-09-08), MIT.
  - A LISTEN/NOTIFY queue with crontab and `job_key` dedup. No step durability.
  - https://worker.graphile.org/docs
  - Note: the Workflow SDK's Postgres World is built on it.

---

## Facts against the stack-agnostic, copied-SDK constraint (ADR 0005)

| Engine       | Extra service to run              | Build or runtime demand on every Host                         | Runs in the app process         |
| ------------ | --------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| Temporal     | Cluster or Cloud                  | webpack bundle of workflow code, native addon, sandbox layout | Worker can, but needs a cluster |
| Restate      | Restate server + disk             | None (plain TS)                                               | Yes (endpoint)                  |
| Hatchet      | Engine (Lite or full) or Cloud    | None (plain TS, gRPC)                                         | Probably (**unverified**)       |
| Inngest      | Inngest server or Cloud           | None (plain TS, `serve()` adapter)                            | Yes (endpoint)                  |
| Trigger.dev  | Cloud (self-hosting needs Docker) | `trigger.config.ts` + `trigger deploy`                        | No                              |
| Workflow SDK | None (Postgres World)             | SWC directive plugin in the Host bundler                      | Yes                             |
| DBOS         | None                              | Must not be bundled; global `DBOS.launch()`                   | Yes                             |
| In-house     | None                              | None                                                          | Yes                             |

## Unverified

- Temporal: Postgres 17/18 support, and resource sizing.
- Restate: paid Cloud prices, and running it on Render.
- Hatchet: children when the parent is cancelled, running the worker in-process, and Hatchet Lite on Render.
- Inngest: self-hosted REST cancel, Render Key Value, an imperative cron API, and whether an event sent before `waitForEvent` starts can match.
- Trigger.dev: how `chat.agent()` works, and a singleton mode.
- Workflow SDK: a build with no framework.
- DBOS: a free Conductor tier, and whether its queues poll or use LISTEN/NOTIFY.
- No vendor documents Render, except Temporal (Render's own guide).
