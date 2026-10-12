---
Status: accepted
---

# Background jobs go through a durable-runner package, in-process by default

Processing Knowledge files, syncing Synced sources and making Memories all happen after the request that caused them, can take minutes, and must survive a deploy. They go through `packages/durable-runner`: one interface (`enqueue`, retries, status) with two implementations. The **in-process** runner, built on the lease-and-reaper approach Runs already use (ADR 0006), is the default and needs nothing beyond Postgres. A **Trigger.dev** runner is opt-in for a Host that wants hosted, separately scaled workers.

Runs themselves don't move onto it. They stay on the run log and pub/sub of ADR 0006, because a Run is streamed to readers live and a job isn't.

## Considered Options

- **Trigger.dev only**: every Host, the example Host and local dev would need an account and a worker before Knowledge or Memory works.
- **BullMQ on the Redis we already run**: a second queue model alongside the lease and reaper, with no hosted option.
- **Run the jobs inline in the request**: a big PDF holds the request open, and a deploy loses the work.

## Consequences

- A new package and an optional Trigger.dev dependency.
- Each job type must be safe to retry, since a reaped lease runs it again.
