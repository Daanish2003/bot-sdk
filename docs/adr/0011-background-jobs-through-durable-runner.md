---
Status: accepted
---

# Background jobs go through a durable runner in the Chat SDK core, in-process by default

Processing Knowledge files, syncing Synced sources and making Memories all happen after the request that caused them, can take minutes, and must survive a deploy. They go through `packages/durable-runner`: one interface (`enqueue`, retries, status) with two implementations. The **in-process** runner, built on the lease-and-reaper approach Runs already use (ADR 0006), is the default and needs nothing beyond Postgres. A **Trigger.dev** runner is opt-in for a Host that wants hosted, separately scaled workers.

Runs themselves don't move onto it. They stay on the run log and pub/sub of ADR 0006, because a Run is streamed to readers live and a job isn't.

## Considered Options

- **Trigger.dev only**: every Host, the example Host and local dev would need an account and a worker before Knowledge or Memory works.
- **BullMQ on the Redis we already run**: a second queue model alongside the lease and reaper, with no hosted option.
- **Run the jobs inline in the request**: a big PDF holds the request open, and a deploy loses the work.

## Consequences

- A new package and an optional Trigger.dev dependency.
- Each job type must be safe to retry, since a reaped lease runs it again.

## Amendment: the runner lives in the Chat SDK core (2026-10-12, #202)

Before anything was built, the runner moved out of its own package. The Chat SDK is the runner's only consumer, and ADR 0005 copies the SDK into a Host as one unit. A separate package would add a second `package.json`, a second copy rule and a second migration path, all to serve one interface.

- **In core.** The `JobRunner` interface and the in-process runner live in `core/server/jobs/`. They share the SDK's pool and migrations, and they start and stop with `chat.start()` and `chat.stop()`.
- **`createChat({ jobs? })`.** The option defaults to the in-process runner, the way `runtime?` defaults to `memoryRuntime()`.
- **Trigger.dev is a Host-owned adapter.** Trigger.dev finds and deploys tasks from the Host's own project, so its runner can't live only in copied code. It ships under `extras/trigger/`, which the copy script copies only once, like `ui/`. Its `enqueue` triggers the Host's task, and that task calls `chat.runJob(name, payload)`.
- **`@trigger.dev/sdk` stays optional.** The SDK's `package.json` never lists it, and the README says which Hosts need it.
- **No new glossary term.** Users see a Knowledge file's status, never a job.

## Amendment: how a job lives (2026-10-12, #203)

- **One `chat.job` table, polled.** Each process polls every 2 s and takes the next due job with `FOR UPDATE SKIP LOCKED`. `enqueue` also wakes its own process. There's no `LISTEN/NOTIFY`, which breaks behind connection pooling (ADR 0006). An idempotency key is unique among active jobs.
- **Retries.** Three attempts, with backoff of about 10 s, 1 min and 5 min. A `PermanentJobError` fails a job at once. When the last attempt fails, the job's `onFailed` runs.
- **An expired lease puts a job back in the queue.** A stale Run ends `error` (ADR 0006), but a stale job is `queued` again, and the attempt counts. Jobs heartbeat every 10 s and hold a 60 s lease, since parsing is CPU-heavy, with a 15-minute limit per attempt.
- **The domain row owns what users see.** A Knowledge file's status lives on its own row, and the job's handler writes it. The runner's own status is for operators and the Trigger.dev adapter, so both runners look the same to users.
- **Cancelling.** Cancelling a queued job drops it. A running job gets an abort signal at its next heartbeat. Every handler checks that its row still exists before writing, so a late cancel is harmless.
- **Concurrency.** Two jobs per process by default. File parsing runs in a `worker_threads` worker so it doesn't stall streaming Runs.
  _Amended 2026-10-13 ([#368](https://github.com/Daanish2003/ai-chat/issues/368)): file parsing runs in-process, on the job runner. The SDK is copied into Hosts as TypeScript source, so there's no built entry for a worker to load, and the runner already keeps parsing off the request path._
- **Recurring jobs:** `schedule(name, { everyMs })`, with no cron. Each slot is enqueued under the key `name:<slot>`, so exactly one process fires it. They're designed now and built with Synced sources.
- **Shutdown and retention.** `stop()` stops taking jobs and drains for `drainMs`, then aborts the rest; their leases expire and another process re-runs them. Succeeded and cancelled jobs are deleted after 7 days, failed ones after 30.
- **Jobs are internal.** `defineJob({ name, payload, run, onFailed })` isn't public, and a Host can't register its own jobs.

## Amendment: the runner is a plugin of the Bot SDK (2026-10-17, [#479](https://github.com/Daanish2003/ai-chat/issues/479))

This replaces the "lives in the Chat SDK core" amendment. ADR 0020 made the SDK one core with plugins, and step 0 left the runner inside the `assistant` plugin. Step 2 moves it into its own **`runner` plugin**, so the assistant and the `bot` plugin share one runner.

- **`runner({ jobs? })`.** `jobs` takes a `JobRunner` and defaults to the in-process runner. `assistant({ jobs })` goes away. A Host lists the plugin itself: `plugins: [models(), runner(), assistant()]`.
- **Its API.** `sdk.plugin("runner")` gives `enqueue`, `cancel`, `status` and `runJob`. A Trigger.dev task calls `chat.plugin("runner").runJob(name, payload)`.
- **Who requires it.** `assistant` requires `runner` for the Knowledge and Memory jobs. `bot` requires it once Turns run on it.
- **Its lifecycle.** The runner owns its own reaper, prune, polling and drain. It starts before the plugins that require it and stops after them, so the assistant drains its Runs first and the runner drains its jobs after, as before.
- **Its data.** `chat.job` moves to the runner's plugin schema, still in the `chat` schema (ADR 0020) and with no migration change. Job definitions stay with their domain and import `defineJob`, which stays internal.
- **Extracted first, unchanged.** The move renames nothing, and the existing jobs tests prove it changes no behaviour. Checkpointed steps come after it and amend this ADR again.
