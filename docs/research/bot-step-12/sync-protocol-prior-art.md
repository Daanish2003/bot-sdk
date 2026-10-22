# Sync protocol prior art

Research for [#750](https://github.com/Daanish2003/bot-sdk/issues/750) (child of map [#423](https://github.com/Daanish2003/bot-sdk/issues/423), step 12 Channels). Researched 2026-10-22. Facts only, no pick.

## Question

How do shipped apps implement slide 19's sync: a data-less "something changed" signal, a sequence number on every update, apps applying updates in order, and a reload from the database on a gap? Where does the sequence number come from in Postgres, what is "an update", what does the client keep, and how does this fit the repo?

## Short answers

1. **The pattern exists in several shipped systems, with variations.** Replicache has the data-less "poke" and then a pull by cookie. Linear (community reverse-engineering only) has a database-wide `lastSyncId` and delta packets. Electric has an `offset` in a shape log and a `must-refetch` control message. Zulip has per-queue event ids and a "queue not found" error that makes the client reload. Matrix has a `since` token and a `limited` flag that tells the client it has a gap.
2. **Where the number comes from differs.** Replicache's global-version strategy keeps one version row and bumps it inside the write transaction (serialising all writes). Replicache's row-version strategy uses a counter per client group. Postgres sequences hand out distinct values but leave gaps and do not promise commit-order visibility. Zulip's ids are increasing but "not guaranteed to be consecutive", so a client there cannot use a gap in the numbers as the gap signal.
3. **"An update" is a row-level change in Linear, Replicache and Electric, a re-run query result in Convex, and a typed event in Zulip and Matrix.**
4. **The client keeps a cursor** (cookie, `lastSyncId`, offset, `last_event_id`, `since`) and usually a local copy. What a "reload" fetches ranges from a full bootstrap (Linear, Electric `must-refetch`, Zulip re-register) to a paged backfill (Matrix `/messages`).
5. **Not read:** Zero's internals (its docs pages fetched say nothing on the protocol), and Linear's own talks (only a community reverse-engineering was readable). See _Gaps in this research_.

## 1. Prior art

### Replicache (Rocicorp), primary: doc.replicache.dev

- **Poke.** "A poke is a contentless hint delivered over pubsub to all relevant Replicaches that they should pull." "The poke doesn't contain any actual data." Delivery channels named: Server-Sent Events, Web Sockets, push services such as Pusher. ([How it works](https://doc.replicache.dev/concepts/how-it-works))
- **Cookie.** "The cookie is a value opaque to the client identifying the canonical server state that the client has." The pull request sends the cookie and `clientGroupID`; the response returns a new cookie, a patch and `lastMutationIDChanges`. (same page)
- **Client mutation ids and dedupe.** Each mutation has "a sequential integer uniquely identifying the mutation in this client". The server applies each "exactly once" and in the client's order; `lastMutationID` per client tells Replicache which pending mutations the server has confirmed, and it drops those with id up to that value. (same page)
- **Mismatch.** The client "rewinds the state of the Client View to the last version it got from the server", applies the patch, then replays pending mutations. "In Replicache, the server is authoritative." (same page)
- **Global version strategy.** One `ReplicacheSpace` record holds a version ("There is only one of these system-wide"). Each push transaction reads it, uses `version + 1`, stamps every modified row's `lastModifiedVersion`, writes the version back and commits. The cookie is the previous version; pull returns rows with `lastModifiedVersion` greater than the cookie. Tradeoffs stated: "all pushes server-wide are serialized"; "`GlobalVersion` functions as a global lock"; with 20 ms pushes the cap is about 50 per second; deletes are soft deletes. It avoids last-modified timestamps because parallel transactions can commit out of order, so clients can permanently miss changes. ([Global version strategy](https://doc.replicache.dev/strategies/global-version))
- **Row version strategy.** Each pull response stores a Client View Record (CVR) under a random id in ephemeral storage, and the id is the cookie. The next pull diffs the stored CVR against a new one built from the database. If a CVR is lost the server sends a reset patch. Cookie order comes from a per-client-group `cvrVersion` counter incremented on each pull. No global lock, hard deletes allowed; cost is "increased implementation complexity and read cost". ([Row version strategy](https://doc.replicache.dev/strategies/row-version))

### Zero (Rocicorp), primary: zero.rocicorp.dev

Only high-level facts were readable: Zero is "a client-server system with an authoritative server"; zero-cache keeps a SQLite replica of the Postgres data; reads and writes go to local storage; no offline writes. The pages fetched say nothing about versions, watermarks, pokes or gap handling. ([Sync](https://zero.rocicorp.dev/docs/sync), [When to use](https://zero.rocicorp.dev/docs/when-to-use)). The change-streamer README path tried in `rocicorp/mono` returned 404.

### ElectricSQL, primary: electric.ax/docs/api/http (electric-sql.com redirects there)

- A **shape log** is read with `offset` (`-1` for the whole log) and `handle` (identifies the shape). "An HTTP client should then continue to make requests setting the `offset` parameter to this header value" (the `electric-offset` response header) until caught up.
- `live=true` is long-polling: the server holds the request until new data or a timeout; the client reconnects with the latest offset, which is how it resumes. `live_sse=true` uses Server-Sent Events.
- Control messages: `up-to-date` ("the client has all the data that the server was aware of when fulfilling the request"); `must-refetch` (discard local data for the shape and resync from scratch); `snapshot-end` (carries Postgres snapshot `xmin`, `xmax`, `xip_list`, "which allows clients to determine which changes have been incorporated into the snapshot").
- `offset=now` skips history.
- Not on that page: the ordering guarantees and transaction-id rules.

### Convex, primary: stack.convex.dev/how-convex-works and convex-js source

- The server keeps an append-only transaction log; "Each timestamp `t` defines a snapshot of the database that includes all revisions up to `t`". Entries sharing a timestamp commit together.
- A query's read set is tracked per WebSocket session. A subscription manager walks the log once and finds entries that overlap read sets; on a hit it tells the sync worker session to re-run the query and push the new result. "All queries in the client's query set are at the same timestamp."
- Wire types in `convex-js` `src/browser/sync/protocol.ts`: `StateVersion { querySet, ts, identity }`, `Transition { startVersion, endVersion, modifications }`, `Connect { sessionId, connectionCount, lastCloseReason, maxObservedTimestamp, clientTs }`, `Mutation { requestId, udfPath, args }`, and `MutationResponse` with a `ts`. The fetched excerpt showed no explicit gap or reload message type, and the article says the sync protocol will be covered in a later post.

### Linear, no primary source readable

Linear's blog post on the sync talk ([linear.app/blog/scaling-the-linear-sync-engine](https://linear.app/blog/scaling-the-linear-sync-engine)) only points to a video; its text has no protocol details. The only detail found is a community reverse-engineering of the web client, [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine), whose author says it is unaffiliated and "there may be inaccuracies". Treat the following as unverified:

- `lastSyncId` is a database-wide counter that "increments by 1" when a server transaction succeeds, and serves as the database version.
- Each sync action has an integer `id`, `modelName`, `modelId`, an action code (insert, update, archive, delete, and others) and `data`. They arrive in delta packets over a WebSocket, to all connected clients including the sender.
- After the WebSocket handshake the client compares the server's `lastSyncId` with its own; if lower, it requests the missing delta packets. Bootstrap is `full`, `partial` or `local` (IndexedDB then deltas); a full bootstrap runs when `lastSyncId` is undefined or models are outdated.
- The text fetched was cut off before the end of the delta chapter, so the exact gap-fill request was not read.

### Zulip, primary: zulip.com/api and zulip.readthedocs.io events-system

- `POST /register` creates an event queue and returns `queue_id` and `last_event_id`; the client long-polls `GET /events`. "Event IDs are guaranteed to be increasing, but they are not guaranteed to be consecutive." ([get-events](https://zulip.com/api/get-events))
- `last_event_id` is "the highest event ID in this queue that you've received and wish to acknowledge"; the server can delete events up to it. Event ids are a per-queue counter. ([events-system](https://zulip.readthedocs.io/en/latest/subsystems/events-system.html))
- Queues are collected after 10 minutes of inactivity by default; a returning client gets a "queue not found" error and "refetches initial data" like at startup. The same happens if the queue server crashes.
- The state fetch and the events are not atomic. Registering creates the queue, fetches state from the database non-atomically, requests events added since the queue was created, and applies them with `apply_events`. The doc says doing the pieces atomically is "nearly impossible".

### Matrix, primary: matrix-spec `client-server-api`

- `/sync` with `since` set to the previous `next_batch`; the server holds the request until events arrive or `timeout` passes.
- If many events arrive between syncs, the timeline is **limited**: only the newest events plus a state delta. "This can leave a gap in the client's message history." The client closes it with `/rooms/{roomId}/messages` using `from` = its previous `since` token and `to` = the room's `prev_batch` token.

### Server-Sent Events, primary: WHATWG HTML spec

- The `id` field sets the last event id; the `Last-Event-ID` request header is sent on reconnection when that string is non-empty. A non-200 or wrong `Content-Type` response is not retried; `retry:` sets the reconnect time (ASCII digits only).

### oRPC event iterator, primary: orpc.dev/docs/event-iterator

- The handler is an async generator. `withEventMeta(data, { id, retry })` attaches SSE `id`/`retry`. On reconnect the client sends the last id, exposed as `lastEventId` in the handler; with the Retry Plugin or EventSource "reconnection with the last event ID is handled automatically". Ending with `return` marks the stream complete in oRPC; plain EventSource clients may reconnect anyway.

## 2. Where the sequence number comes from in Postgres

| Source                                                                           | Gap behaviour                                                                                                                                                       | Concurrency / ordering                                                                                                 | Cited by                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| One counter row bumped inside the write transaction                              | No gaps from aborts (the bump rolls back with the transaction)                                                                                                      | Writers to that row serialise; Replicache measures about 50 writes per second at 20 ms each                            | Replicache global version                                                                                                |
| Per-scope counter row (here: per client group, bumped per pull)                  | Counter is for cookie order only                                                                                                                                    | Only that scope serialises                                                                                             | Replicache row version                                                                                                   |
| Postgres `SEQUENCE` / `nextval`                                                  | "transaction aborts or database crashes can result in gaps"; also gaps with `INSERT ... ON CONFLICT`; "sequence objects cannot be used to obtain gapless sequences" | Each concurrent caller gets a distinct value; the page does not say values become visible in the order they were taken | Postgres docs ([functions-sequence](https://www.postgresql.org/docs/current/functions-sequence.html))                    |
| Transaction snapshot (`xmin`, `xmax`, `xip_list`)                                | n/a                                                                                                                                                                 | A higher transaction id does not imply a later commit; visibility is "completed at snapshot time"                      | Postgres docs ([functions-info](https://www.postgresql.org/docs/current/functions-info.html)); Electric's `snapshot-end` |
| Timestamp of last change                                                         | n/a                                                                                                                                                                 | Parallel transactions can commit out of order, so a reader can miss rows                                               | Replicache (names this as the reason for its strategies)                                                                 |
| Per-queue in-memory counter                                                      | Increasing, not consecutive                                                                                                                                         | One queue server                                                                                                       | Zulip                                                                                                                    |
| Database-wide counter, "increments by 1" per successful transaction (unverified) | Not described                                                                                                                                                       | Not described                                                                                                          | Linear (community)                                                                                                       |

Not found in a primary source: how Linear takes the counter inside Postgres, and how Convex or Zero choose theirs.

## 3. What "an update" is

| System             | Unit of update                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Replicache         | A row-level `put` / `del` / `clear` in a patch between two cookies                       |
| Linear (community) | One `SyncAction`: insert / update / archive / delete of one model row, in a delta packet |
| Electric           | A row change in a shape's log                                                            |
| Convex             | A `Transition` of query-result modifications between two `StateVersion`s                 |
| Zulip              | A typed event (for example a message, a flag change) with an id                          |
| Matrix             | A room event, plus a state delta when the timeline is limited                            |

None of the sources read describe a step-by-step status change as its own update type; where a status lives in a row (Linear, Replicache, Electric) it travels as a row change.

## 4. What the client keeps and how it detects a gap

| System             | Cursor                            | Local copy                        | Gap signal                                                    | What reload fetches                          |
| ------------------ | --------------------------------- | --------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Replicache         | cookie                            | yes (client view)                 | The pull's cookie is the base; a lost CVR means a reset patch | A patch from the cookie, or `clear` plus all |
| Linear (community) | `lastSyncId`                      | IndexedDB                         | Server `lastSyncId` > local at handshake                      | Missing delta packets, or a bootstrap        |
| Electric           | `offset` + `handle`               | optional                          | `must-refetch` control message                                | The whole shape from `offset=-1`             |
| Convex             | `maxObservedTimestamp` on Connect | query results                     | Not shown in the excerpt                                      | Not shown in the excerpt                     |
| Zulip              | `last_event_id`                   | initial state plus applied events | "queue not found" error                                       | Full re-register and initial state           |
| Matrix             | `since` / `next_batch`            | yes                               | `limited: true` on a room timeline                            | `/messages` between `prev_batch` and `since` |
| SSE                | `Last-Event-ID`                   | n/a                               | Only what the server chooses to replay                        | Server-defined                               |

## 5. Fit with this repo (read from the files)

Paths are under `packages/bot-sdk/`.

- **A data-less hint already exists.** `hintChanged` in `plugins/bot/server/turn.ts` publishes `{"type":"changed"}` on `conversation:<id>` (`conversationChannel` in `core/server/chat/conversation-events.ts`); a failed publish is logged, never thrown. Callers include the Turn end, Check-in fire and demonstration capture.
- **Pub/sub is at most once.** `core/server/chat/pubsub.ts` documents "delivered at most once ... never replayed"; the Redis version (`redis-pubsub.ts`) matches Redis's documented at-most-once semantics ("If the subscriber is unable to handle the message ... the message is forever lost", [Redis pub/sub](https://redis.io/docs/latest/develop/pubsub/)). ADR 0006's #290 amendment states "Events are hints, not the record" and "A tab that missed an event finds the rest on its next load." The memory version only reaches subscribers in the same process.
- **The SSE route has no ids.** `handleConversationEvents` writes `data: <message>\n\n` and `: ping` every 25 s. It writes no `id:` field and does not read `Last-Event-ID`. It answers only the owner (404 otherwise). Nothing in the route replays.
- **The Bot thread follows through an oRPC event iterator.** `bot.send` returns `followTurn`, an `AsyncGenerator<BotSendEvent>` (`message` or `turnEnded`, `plugins/bot/shared/turn.ts`). It subscribes to the Conversation channel, and on each hint or every `followPollMs` (2 000 ms) re-reads the Trigger's Turn status, then the Messages after the user Message's `createdAt`, yielding those not in a `shown` set (id-based, not sequence-based). It ends when the Turn ends. The generator has no event ids, so oRPC's `lastEventId` resume is not used today.
- **Client polling.** `plugins/bot/client/react/bot-turn.ts` refetches `bot.get` every 2 s while a Turn runs somewhere other than this client; `check-ins.ts`, `helpers.ts`, `reviews.ts` and `routines.ts` do the same with `refetchInterval: 2000` while work is live.
- **Client-chosen ids and dedupe already exist for user Messages.** `bot.send` takes the id, locks the Conversation row (`lockConversation`, `SELECT ... FOR UPDATE` in `plugins/bot/server/router.ts`), and `seenMessage` returns the earlier Message of a repeat send, which "re-joins its Turn" (`plugins/bot/server/turn.ts`). An id held by another Conversation is `BAD_REQUEST`.
- **A per-Conversation row lock is already taken** by every transaction that starts or ends a Turn, and `appendMessage` (`core/server/chat/message-tree.ts`) locks the Conversation row `FOR UPDATE` before inserting a Message. So Message inserts for one Conversation are already serialised, which is the shape of the counter-under-row-lock row in the table above. Messages are keyed by `uuidv7()` unless an id is supplied. No sequence column or log table for Conversation changes was seen in the files read (`core/server/db/schema.ts` composes plugin fields; the plugin column files were not each read).
- **Other state changes do not go through `appendMessage`.** Turn status, Trigger, Check-in, Helper and Routine state live in plugin tables and are surfaced by `hintChanged` plus re-reads; only Messages are yielded by `followTurn`.
- **Postgres `LISTEN`/`NOTIFY` is not used anywhere** in `core/` or `plugins/` (grepped). ADR 0006 lists it under "Considered Options" for a Host without Redis and notes "`LISTEN` fails behind transaction pooling".
  - Postgres docs: payload under 8000 bytes by default; "messages from different transactions are delivered in the order in which the transactions committed"; delivery only on commit; identical channel+payload within one transaction are folded into one; a full queue (8 GB standard) makes `NOTIFY` transactions fail at commit; a session that holds `LISTEN` in a long transaction blocks cleanup ([NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)).
  - PgBouncer lists `LISTEN` as "Never" supported in transaction pooling and `NOTIFY` as supported ([features](https://www.pgbouncer.org/features.html)).
  - Postgres docs do not document what a disconnected listener misses; the NOTIFY page describes delivery to sessions that "previously executed LISTEN".
- **Redis is already a runtime option.** `redisRuntime` (ADR 0006) provides Redis pub/sub and Redis Streams (`redis-run-streams.ts`) for Run chunk logs, which are replayable and append-only; the Run log is a different thing from a Conversation change log.

## Gaps in this research

- Zero's protocol internals, and Linear's own account of its protocol, were not readable from primary sources here.
- Convex's reconnect and gap behaviour was not shown in the readable excerpts.
- Zulip's `BAD_EVENT_QUEUE_ID` error code was not read directly; the "queue not found" behaviour comes from the events-system page.
- Electric's `electric-cursor` header and ordering rules were not on the fetched page.
- The `message` table's plugin-contributed columns were not each inspected for a sequence column.
