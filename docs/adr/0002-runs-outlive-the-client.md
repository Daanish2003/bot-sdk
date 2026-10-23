---
Status: superseded by ADR 0027
---

# Assistant runs outlive the client; Stop is an explicit call

TanStack AI's default ties a run to its HTTP request: when the client disconnects (Stop, reload, closed tab), the response stream's `cancel()` aborts the provider call. We decouple them instead. `/api/chat` keeps draining `chat()` to the end whether or not anyone is reading the SSE stream, and snapshots the assistant Message's `parts` to Postgres at most once a second. A reloaded page polls the Active Branch until nothing is `streaming`. Stop is an explicit oRPC `chat.stop({ messageId })` that aborts the run through an in-process `AbortController` registry, so the server alone decides how a run ends (`complete`, `stopped` or `error`) and the client just sees the stream close.

Closing a tab shouldn't throw away a long answer, and it was unverified whether Nitro even propagates a client disconnect into `ReadableStream.cancel()`.

## Considered Options

- **Disconnect means stop**: simplest, but loses work on reload and relies on unverified Nitro behaviour.
- **Resumable streams (re-attach to live tokens)**: best UX, but needs TanStack AI's durable-stream plumbing, which we gave up by not using `withPersistence` (ADR 0001).

## Consequences

- The registry is a process-local `Map`, which is fine for one process under Docker Compose. Scaling past one process would need a shared cancel signal.
- Unattended runs need guards: a 5-minute hard limit per run, and on boot every `streaming` row is set to `error` ("interrupted").
- One run per Conversation: the server returns 409 while a Message is `streaming`.
