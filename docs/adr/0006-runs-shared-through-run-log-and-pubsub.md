---
Status: accepted
---

# Runs are shared across processes through a run log and pub/sub

ADR 0002 still holds: a Run outlives the client and Stop is an explicit call. But its registry, boot sweep and polling only work in one process, and the Chat SDK runs in several. So a Run's state that other processes need goes through two seams, which `createChat` takes together as one `runtime` option (it replaces ADR 0005's `pubsub?`):

- **`PubSub`**: control signals between processes, delivered at most once.
- **`RunStreams`**: one append-only, replayable chunk log per Run, keyed by the Run's id, following TanStack AI's `StreamDurability` contract. Appends are batched (about 50 ms).

The SDK ships `memoryRuntime()` (the default, one process) and `redisRuntime({ url, prefix? })` (Redis pub/sub plus Redis Streams, using the `redis` client, one dedicated subscriber connection per process, keys and channels prefixed `chat:` by default). A third seam, `RunExecutor`, stays internal, with only an in-process version: the Run executes where its POST landed, until a serverless Host needs another.

- **One read path.** The Run appends every chunk to its log before anyone reads it, and the POST response and any later reader both read the log. A reloaded page joins a `streaming` Message with TanStack's `joinRun(runId)` against a `GET` that replays and tails the log, and the 1 s polling goes. The log expires an hour after it closes. Postgres stays the source of truth for history.
- **Stop from any process.** `stopRun` sets `cancel_requested_at` on the Message and publishes on the Run's cancel channel. It never writes `status`; the owning process aborts, from the message or from the column it reads back on its next snapshot write, and saves the Run `stopped`. If the Run's heartbeat has already expired, `stopRun` marks it `stopped` itself.
- **A lease, not a boot sweep.** The owning process writes `heartbeat_at` every snapshot interval, even when nothing changed. Every process reaps in `start()` and every 30 s: a `streaming` Message whose heartbeat is older than the lease (30 s) becomes `error` "interrupted", its running searches are cancelled and its log closed.
- **Shutdown.** `stop()` refuses new Runs (503), lets local Runs finish for up to `drainMs` (250 s), then ends the rest as `error` "interrupted" and closes their logs.
- **Unchanged:** one Run per Conversation (the Conversation row lock), the 5-minute limit per Run.

## Considered Options

- **Keep ADR 0002's in-process registry**: one process only.
- **A queue as executor** (BullMQ, pg-boss, Inngest, Trigger.dev): only buys surviving a dead process or serverless, and Stop still needs `PubSub`. Deferred behind `RunExecutor`.
- **Postgres `LISTEN/NOTIFY` as the production pub/sub, or a Postgres chunk table as the log**: avoids Redis, but puts every token batch through WAL and `LISTEN` fails behind transaction pooling. Left for a Host without Redis.
- **POST reads a local channel, only joiners read the log**: saves about 50 ms of text latency, at the cost of two read paths.

## Consequences

- Two new columns on `chat.message`: `cancel_requested_at` and `heartbeat_at`.
- Production needs Redis, and the SDK depends on `redis`.
- Whether `resumeServerSentEventsResponse` accepts a `StreamDurability` keyed by our Run id is unverified; the first implementation ticket checks it, and the fallback is our own SSE `GET` over `RunStreams.read`.

## Amendment: a Message's later Runs (2026-10-10, #158)

A Message can span several Runs: a decision on a call that waits for Approval starts the next one on the same Message (ADR 0008). Each Run keeps its own log, so the amendment keeps the rules above and adds:

- **A resumed Run's id is `<messageId>:<n>`**, where `n` is the Run's number on its Message. The first Run keeps the Message's id, so logs written before this change read the same.
- **The Message stores its current Run number** (`message.run_number`, starting at 1). Joining a Message reads the log of its current Run, so a reader finds the newest log.
- **Logs stay append-only and close once.** A Run closes its own log, and no Run reopens another Run's log. A Run that ends waiting for Approval closes its log like any ended Run.
