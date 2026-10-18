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

## Amendment: a job is a workflow replayed from its history (2026-10-17, [#481](https://github.com/Daanish2003/ai-chat/issues/481))

Step 2 lets a Turn survive a crash or a deploy by resuming from its last **Checkpoint**. The runner copies Temporal's model, built in-house in plain TypeScript on Postgres, with no Temporal server and no new dependency: a workflow records what it did in a history and is resumed by replaying its code against that history. Temporal also runs workflow code in a sandbox that enforces determinism. This runner leaves that out and catches broken determinism on replay instead, as DBOS does. The research behind it is [How Postgres-native durable execution engines work inside](https://github.com/Daanish2003/ai-chat/issues/408).

- **A `chat.job` row is the workflow.** Its claim, lease, attempts and status are unchanged. One table is added: `chat.job_event (job_id → job.id on delete cascade, seq, kind, name, result jsonb, created_at)`, keyed by `(job_id, seq)`. Pruning a job removes its history. Today's jobs are workflows with an empty history and behave as before. Nothing is renamed.
- **What is recorded, in call order:**

  | Call                     | Recorded                                    |
  | ------------------------ | ------------------------------------------- |
  | `ctx.activity(name, fn)` | `fn`'s JSON result, which is the Checkpoint |
  | `ctx.now()`              | the time it returned                        |
  | `ctx.random()`           | the number it returned                      |
  | `ctx.patched(id)`        | a marker                                    |

  Durable sleep and cron (step 4), messages into a running workflow (step 3) and child workflows (step 6) add kinds later.

- **Replay.** A resumed attempt runs the workflow from the top. Each call reads the next history entry, and while entries remain it returns the recorded result without running anything. Past the end of the history, calls run for real and are recorded.
- **Non-determinism fails the job.** If the entry at a seq has a different kind or name from the call, replay throws a `NonDeterminismError`. Like a `PermanentJobError`, it fails the job at once and runs `onFailed`. Its message names the seq, the recorded entry and the call. Temporal instead retries until a fixed deploy unsticks the workflow. Here a Turn that ends with an error is better than one stuck forever, and runs last minutes, not months.
- **The rule for workflow authors.** Code outside `ctx.activity` runs again on every attempt, so anything that decides which call comes next must be deterministic. Times and random numbers come from `ctx.now()` and `ctx.random()`. Reads and side effects go inside an activity.
- **Code changes go through `ctx.patched(id)`, as in Temporal.** In a new run, it returns `true` and records a marker. A replay with the marker returns `true`. A replay that passes this point without the marker (a run started before the deploy) returns `false` and records nothing. There's no `deprecatePatched`: a patch is deleted from the code once no run older than its deploy is left.
- **Fenced on every write.** In one transaction, a history entry is inserted only while this attempt still owns its row (the `ownAttempt` fence), and `heartbeat_at` is bumped, so each write also renews the lease. If nothing is written, the lease is lost or the job was cancelled, and the attempt aborts the way a failed heartbeat aborts it. Side effects are at-least-once: a crash after `fn` but before its entry is saved runs `fn` again.
- **A thrown activity records nothing.** The attempt fails, and the job retries under the existing three attempts with backoff. Replay skips the activities that already finished, so retrying the job amounts to retrying the failed activity. There are no per-activity retry policies. A `PermanentJobError` fails the job at once.
- **Recovery is unchanged:** a 10 s heartbeat, a 60 s lease, and the reaper re-queues an expired row, which counts as an attempt. Any process can claim the row and replay it.
- **A deploy hands work back at a Checkpoint.** `stop()` asks each running workflow to yield. Its next `ctx.activity` saves, then yields. The runner puts the row back as `queued` with `run_after = now`, without counting the attempt, under the same fence, so another process resumes it at once instead of a lease later. A job still running after `drainMs` is aborted as before.
- **Cancel is unchanged.** The row becomes `cancelled`, and the attempt aborts at its next heartbeat or, sooner, at its next write's fence.
- **Polling stays.** There's still a 2 s poll plus a wake-up on `enqueue`, and no LISTEN/NOTIFY.
- **Trigger.dev records nothing.** Under the Trigger.dev adapter there's no `chat.job` row, so every `ctx` call runs for real and saves nothing, and Trigger.dev's own retries apply. Whether Turns need the in-process runner is decided with [A Turn as a durable workflow](https://github.com/Daanish2003/ai-chat/issues/482).
- **Left to later work:** an activity that commits a same-database write in its own transaction, for exactly-once (ticket 482).

### Considered options

- **Checkpoints looked up by name, with no replay checks.** This is simpler, but a changed workflow can silently take a different path on resume.
- **A sandbox that enforces determinism, as Temporal's TypeScript SDK has.** It's the largest piece of Temporal and has no other use here.
- **DBOS Transact as a dependency.** Its model is the same and it has been used in production, but the engine is meant to be in-house ([Durable runner SDK design](https://github.com/Daanish2003/ai-chat/issues/391)).

## Amendment: a Turn is a workflow (2026-10-17, [#482](https://github.com/Daanish2003/ai-chat/issues/482))

The `bot` plugin runs each Turn as one runner job, keyed by the Turn id, and requires `runner`. This settles the two points the history amendment left open.

- **Exactly-once writes.** `ctx.activity(name, (tx) => …)` gives `fn` the transaction its history entry is saved in, so a same-database write commits with its Checkpoint or not at all. A Turn records an activity for each model call and one for each tool call. SendToUser appends its Message, and a model call records its usage, inside that transaction, so neither happens twice across a crash. Replay returns the recorded model output instead of calling the model again, so the tool calls that follow it replay in the same order.
- **Limits stay out of replayed code.** The Step limit counts recorded model calls. The 5-minute limit runs from the Turn's start, wall clock, as a timer that aborts the live call, never as a branch the workflow takes, so a replay takes the recorded path.
- **Turns need the in-process runner.** Under Trigger.dev nothing is recorded and a retry starts over, which would send Messages again, so `bot` refuses to start on that adapter. The knowledge and memory jobs still run on either.
- **The job is the Turn's liveness.** `bot_turn` links to its job and loses `heartbeat_at` and its "interrupted" sweep. A job that uses up its attempts ends its Turn `error` with `interrupted`.
- **The engine has no Bot SDK imports.** It's a module inside `plugins/runner/`, so it could become its own package later without a rewrite. It stays a plugin now (ADR 0020).

## Amendment: Routines and Check-ins fire as self-chaining jobs (2026-10-18, [#537](https://github.com/Daanish2003/ai-chat/issues/537), [#540](https://github.com/Daanish2003/ai-chat/issues/540))

Step 4 needs schedules like "weekdays 8:00" in the user's time zone. `everyMs` can't express that. Research: [#536](https://github.com/Daanish2003/ai-chat/issues/536).

- **A Routine fires through its own self-chaining job,** not through `schedule()`. Each fire hands its Trigger to the Router. In the same transaction it enqueues the next fire with `runAfter` set to the next slot, under the idempotency key `routine:<id>:<slot>`. Approving or resuming a Routine enqueues its first fire. Pausing, editing or deleting it cancels the queued one. The Routine's row is its schedule, so the runner gets no schedule table.
- **A Check-in is one delayed job** under `check_in:<id>`.
- **`schedule(name, { everyMs })` stays unbuilt** until something needs a fixed interval.
- **Missed fires run once, late.** A job whose `runAfter` passed while nothing ran fires when the runner is back, and the next slot is counted from then. Older slots aren't replayed.
- **Durable sleep stays deferred.** No workflow waits mid-run yet. The `sleep` history kind arrives with the first one, probably Helpers in step 6.
