# Prior art: per-conversation queues, skipping the line and batching

Research for [#497](https://github.com/Daanish2003/ai-chat/issues/497) (child of map [#414](https://github.com/Daanish2003/ai-chat/issues/414), Bot step 3). Researched 2026-10-17. This note reports facts only. Where the queue lives, how an interrupt behaves and the batching rule are decided by the grilling tickets it blocks (#499, #500, #501).

## Question

How do prior-art systems run **one turn at a time per conversation**, let a new message **skip the line** (interrupt vs stop vs steer), and **batch quick messages** into one turn? How are a per-key serial queue and an interrupt expressed on Postgres? What does our runner already offer?

## Sources

GitHub sources were read at their default branch (`main`) on 2026-10-17 with `gh api`. Links point at `main` and are not pinned.

- **[OC]** OpenClaw, [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Its repo `docs/*.md` is the source of docs.openclaw.ai, which did not resolve over DNS during this research.
- **[HA]** Hermes Agent, [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent).
- **[LC]** Letta Code, [`letta-ai/letta-code`](https://github.com/letta-ai/letta-code), plus the Letta API reference at docs.letta.com.
- **[DBOS]** DBOS TypeScript docs at [docs.dbos.dev](https://docs.dbos.dev/typescript/reference/queues) and the [`dbos-inc/dbos-transact-ts`](https://github.com/dbos-inc/dbos-transact-ts) source.
- **[WF]** Vercel Workflow SDK docs at [workflow-sdk.dev](https://workflow-sdk.dev/docs/foundations/hooks) (useworkflow.dev now redirects there with a 308) and the [`vercel/workflow`](https://github.com/vercel/workflow) source.
- **[L]** Lee Robinson, "How always-on agents work", the transcript PDF `transcript-L1OBRtfPS34.pdf` ([youtube.com/watch?v=L1OBRtfPS34](https://www.youtube.com/watch?v=L1OBRtfPS34)). Timestamps are the transcript's own.
- **[R]** This repo at `origin/main` `6e111488`: `packages/bot-sdk/plugins/runner/server/**` and `packages/bot-sdk/plugins/bot/server/turn.ts`.

## Vocabulary across systems

The systems use the same few words with slightly different meanings:

| Behaviour for a message that arrives mid-turn              | OpenClaw                       | Hermes                                                             | Letta Code                                           |
| ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Inject into the running turn at the next tool boundary     | `steer` (default)              | `steer`                                                            | not found                                            |
| Abort or redirect the running turn and run the new message | `interrupt` (old turn dropped) | `interrupt` (gateway default; partial output kept as a checkpoint) | Esc, then send                                       |
| Queue the message as its own later turn                    | `followup`                     | `queue`                                                            | not offered (queued messages coalesce)               |
| Queue, then merge the queued messages into one later turn  | `collect`                      | `queue` plus a 0.35 s / 1.0 s text debounce                        | the default: everything queued dequeues as one batch |
| Hard stop with no new turn                                 | `chat.abort`, `/stop`          | `/stop`                                                            | Esc, `/cancel`, the server's cancel API              |

## OpenClaw [OC]

### One run per session

- Every run takes a per-session lane `session:<key>`, shared across its CLI, embedded and Codex runtimes. "Per-session lanes guarantee that only one agent run touches a given session at a time" ([`docs/concepts/queue.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md)).
- Runs then enter a global `main` lane capped by `agents.defaults.maxConcurrent`, which defaults to `max(8, CPU parallelism × 4)`. A lane with no configuration has concurrency 1. Sub-agents default to 8 per spawning session.
- A running turn is never pre-empted by the lane itself. Only the queue modes below change what a new message does.

### Queue modes

Set with `messages.queue.mode`, or per session with `/queue <mode>` ([`queue.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md)).

- **`steer`** is the default, the hard-coded fallback in [`src/auto-reply/reply/queue/settings.ts`](https://github.com/openclaw/openclaw/blob/main/src/auto-reply/reply/queue/settings.ts). The message is injected into the active run ([`docs/concepts/queue-steering.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue-steering.md)):
  - A running tool is never aborted. Steering text is appended after the tool results, before the next model call.
  - In sequential tool mode the first executable call always starts. After that, a waiting steer skips the unstarted tail, and each skipped call gets the synthetic result "Skipped to process an incoming message." Parallel batches are never skipped.
  - If the runtime cannot accept steering, the message waits until the run ends.
- **`followup`**: no steering. Each message becomes its own turn after the current run ends.
- **`collect`**: no steering. After the quiet window, compatible queued messages (same routing, auth and execution settings) merge into one followup turn. On channels with durable ingress (Discord, Telegram), `collect` behaves like `followup`.
- **`interrupt`**: aborts the session's active run, then runs the newest message. The old turn is not resumed.
- **Aliases** ([`normalize.ts`](https://github.com/openclaw/openclaw/blob/main/src/auto-reply/reply/queue/normalize.ts)): `abort` is read as `interrupt` and `coalesce` as `collect`. In persisted state, the retired `steer-backlog`, `steer+backlog` and `steer_backlog` are read as `followup`, and `queue` and `queued` as `steer`.

### Debounce, cap, drop

Defaults from [`src/auto-reply/reply/queue/state.ts`](https://github.com/openclaw/openclaw/blob/main/src/auto-reply/reply/queue/state.ts), lines 50–52:

| Setting                 | Key                                                      | Default                            |
| ----------------------- | -------------------------------------------------------- | ---------------------------------- |
| Quiet window            | `messages.queue.debounceMsByChannel.<ch>` or per session | `DEFAULT_QUEUE_DEBOUNCE_MS = 500`  |
| Queue cap               | `messages.queue.cap`                                     | `DEFAULT_QUEUE_CAP = 20`           |
| What happens at the cap | `messages.queue.drop`                                    | `DEFAULT_QUEUE_DROP = "summarize"` |

- **Drop policies** ([`queue.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md)):
  - `summarize` drops the oldest entries but keeps short summaries of them, injected as a synthetic followup prompt.
  - `old` drops the oldest entries with no summary.
  - `new` rejects the newest message.
- **Precedence**: the mode resolves in this order: `/queue` override, then `byChannel.<ch>`, then `mode`, then `"steer"`. The debounce resolves in this order: session value, then `debounceMsByChannel.<ch>`, then the plugin default, then 500. `cap` and `drop` are global or per session, not per channel. Values are clamped to cap ≥ 1 and debounce ≥ 0. An example command: `/queue collect debounce:0.5s cap:25 drop:summarize`.

### Inbound burst debounce

A separate stage before the queue: `messages.inbound.debounceMs` and `messages.inbound.byChannel.<ch>` ([`docs/concepts/messages.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md), [`src/auto-reply/inbound-debounce.ts`](https://github.com/openclaw/openclaw/blob/main/src/auto-reply/inbound-debounce.ts)).

- **Defaults**: the code default is 0 (off). The `2000` in the docs is only an example. Telegram batches text by default with a 300 ms quiet window, and text of 4000+ characters waits up to 1500 ms for continuations.
- **Scope**: only text is debounced; media flushes at once. Control commands (stop, abort, status) skip the debounce. Batches are scoped to channel plus conversation, and replies thread to the latest message.
- **Hard deadline**: `MAX_DEBOUNCE_WINDOW_MULTIPLIER = 5`. A batch closes by debounceMs × 5 after its first item unless `maxWaitMs` is given. The first item's deadline stays fixed (inbound-debounce.ts lines 131 and 393–399).

### Stop

- `chat.abort` with a `runId` cancels that turn, even while it is still queued.
- `chat.abort` without one cancels queued turns first, then active runs, so the queue cannot promote work into a half-stopped session.
- Esc or `/stop` in the TUI aborts the session ([`queue.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md)).

## Hermes Agent [HA]

### Busy input modes

`display.busy_input_mode`, or env `HERMES_GATEWAY_BUSY_INPUT_MODE`. The default is `interrupt`, and unknown values fall back to it ([`gateway/run_config_loaders.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/run_config_loaders.py), `_load_busy_input_mode`, lines 247–250). Sources for the modes: [`website/docs/user-guide/messaging/index.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md) lines 428–458 and [`cli.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/cli.md) lines 412–441.

- **`interrupt`** redirects the active turn:
  - Model generation restarts. The displayed reasoning and partial text are kept as a checkpoint.
  - Completed tool results stay, and running tools finish first.
  - A running foreground `terminal` command is moved to the background, not killed.
- **`queue`** runs the message as the next turn. The queue is held by the gateway and survives a crash.
- **`steer`** injects the message (`/steer`) after the next tool call. It falls back to `queue` if the agent hasn't started or images are attached.
- **`/stop`** is the hard cancel. `/queue <prompt>`, `/queue list|rm|edit|move` and `/busy queue|steer|interrupt|status` control the queue explicitly.
- **Defaults differ by surface**: the gateway defaults to `interrupt`, the TUI to `queue`, and classic `hermes chat` always queues.
- **Busy ack**: `display.busy_ack_enabled`, default true, replies in the chat with an acknowledgement emoji.

### Batching

Source: [`gateway/platforms/base.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/base.py).

- **Busy-text debounce** (queue mode only):
  - Defaults: `DEFAULT_BUSY_TEXT_DEBOUNCE_SECONDS = 0.35` and `DEFAULT_BUSY_TEXT_HARD_CAP_SECONDS = 1.0` (lines 112–113), set with `display.busy_text_debounce_seconds` and `display.busy_text_hard_cap_seconds`.
  - The flush deadline is `min(last_ts + debounce, first_ts + hard_cap)` (`_text_debounce_delay`, around line 3798).
  - Only plain non-command text from the same sender merges, joined with blank lines. A different sender flushes the buffer first.
  - Other busy messages merge into one pending slot per session (`merge_pending_message_event`), and photo bursts merge into one album turn (around line 4149).
  - No item-count cap was found (unverified). The messaging doc says each queued follow-up gets its own turn, but the code and that doc's own config block show the merge.
- **Idle inbound batching**, for adapters that opt in (lines 2474–2511):
  - Keys: `text_batch_delay_seconds` (default 0.3, max 2.0) and `text_batch_split_delay_seconds` (default 1.0, max 4.0). The split delay applies when the last chunk is at least 4000 characters.
  - The base-class default is 0 (off). Which adapters opt in is unverified.

### One run per session

A per-session `asyncio.Event` for the interrupt, plus an owner task in `_active_sessions` (base.py, around lines 1946 and 4549). This is in-process and in memory.

## Letta Code [LC]

- **The queue**, in [`src/queue/queue-runtime.ts`](https://github.com/letta-ai/letta-code/blob/main/src/queue/queue-runtime.ts):
  - Messages sent during a turn go into a `QueueRuntime` and are dequeued when the turn ends.
  - `tryDequeue` drains every consecutive ready "coalescable" item with the same agent and conversation into **one batch, so one turn**. The coalescable kinds are `message`, `task_notification`, `cron_prompt` and `mod_continue`.
  - Barrier kinds (`approval_result`, `overlay_action`) dequeue alone, and `noCoalesce` items always run as their own turn.
  - There is no time-based debounce: the batch is whatever piled up while the agent was busy.
- **Caps**:
  - `maxItems` defaults to 100. At the limit the oldest coalescable item is dropped. `hardMaxItems` defaults to `maxItems * 3` (lines 181–271).
  - The TUI uses `maxItems: Infinity` ([`tui-queue-runtime.ts`](https://github.com/letta-ai/letta-code/blob/main/src/cli/helpers/tui-queue-runtime.ts)).
  - The background-notification bridge holds `MAX_PENDING_MESSAGES = 10` ([`message-queue-bridge.ts`](https://github.com/letta-ai/letta-code/blob/main/src/utils/message-queue-bridge.ts)).
- **Interrupt** ([`use-interrupt-handler.ts`](https://github.com/letta-ai/letta-code/blob/main/src/cli/app/use-interrupt-handler.ts)):
  - Esc aborts the stream and client-side tools, marks incomplete tools cancelled, blocks dequeue and calls the backend `cancelConversation`.
  - Queued user messages are parked until Enter or the next message, while system items keep flowing.
  - The UI warns that a failed backend cancel can leave the server run going, and the next send then hits **CONFLICT**.
  - No steer path into a running turn was found (unverified that none exists).
- **Serialization**:
  - Channels: `/cancel` aborts the routed chat's turn ([`src/channels/README.md`](https://github.com/letta-ai/letta-code/blob/main/src/channels/README.md)).
  - Listener mode: inbound messages are serialized on a `messageQueue: Promise` chain per runtime ([`src/websocket/listener/types.ts`](https://github.com/letta-ai/letta-code/blob/main/src/websocket/listener/types.ts)).
- **Server cancel**:
  - `POST /v1/agents/{agent_id}/messages/cancel` takes optional `run_ids[]`. Cancelling active runs needs Redis ([docs.letta.com](https://docs.letta.com/api-reference/agents/messages/cancel)).
  - `client.conversations.cancel(id)` cannot target a single run ([`src/backend/backend.ts`](https://github.com/letta-ai/letta-code/blob/main/src/backend/backend.ts) lines 659–680).

## DBOS on Postgres [DBOS]

### Per-key serial queue

- **Registering a queue**: `DBOS.registerQueue(name, opts)` takes these options ([reference/queues](https://docs.dbos.dev/typescript/reference/queues)):
  - queue-wide: `globalConcurrency`, `workerConcurrency`, `rateLimit: { limitPerPeriod, periodSec }`
  - per partition: `partitionConcurrency`, `partitionWorkerConcurrency`, `partitionRateLimit`
  - also `minPollingIntervalMs` (default 1000) and `onConflict`
- **Partitioning**: a queue is partitioned when any `partition*` limit is set, and each partition key gets its own limit. The tutorial's example is one at a time per user ([queue-tutorial](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)):
  - `DBOS.registerQueue("example_queue", { partitionConcurrency: 1 })`
  - `DBOS.startWorkflow(fn, { queueName, enqueueOptions: { queuePartitionKey: userId } })`
- **Partition rules**: queue-wide limits still apply across partitions, and each partition limit must be ≤ its queue-wide counterpart. A workflow enqueued on a partitioned queue **without** a key stays `ENQUEUED` and never runs.
- **`EnqueueOptions`** ([reference/methods](https://docs.dbos.dev/typescript/reference/methods)): `deduplicationID`, `priority`, `delaySeconds`, `queuePartitionKey`.
  - `deduplicationID`: only one workflow per ID may be `DELAYED`, `ENQUEUED` or `PENDING` in a queue, across all its partitions. A duplicate throws `DBOSQueueDuplicatedError`, or returns the existing handle with `duplicationPolicy: 'return-existing'`.
  - `priority`: 0 to 2^31−1, lower runs first. `DBOS.setWorkflowPriority` changes it while the workflow is queued.
- **Dequeue SQL** (`src/system_database.ts`, `findAndMarkStartableWorkflows`, about lines 3635–3800):
  - It selects `status='ENQUEUED'` rows for the queue (and partition key), ordered by `priority, created_at`, then updates them to `PENDING` with the executor's id.
  - It locks with `FOR UPDATE NOWAIT` when a shared budget exists (any concurrency or rate limit), otherwise `FOR UPDATE SKIP LOCKED`.
  - It runs at `REPEATABLE READ`, or `SERIALIZABLE` when a partition sweep also shares a queue-wide limit.
  - A batched head-of-line path, `findAndMarkStartablePartitionedWorkflows` (about line 3847), serves queues with partition concurrency 1 and no queue-wide limit.
  - `created_at` is stamped to increase within each partition key, which keeps per-key FIFO order.

### Messages into a running workflow

Source: [workflow-communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication).

- **`DBOS.send(destinationID, message, topic?, idempotencyKey?)`** persists the message. It is exactly-once from a workflow, and from outside when given an idempotency key.
- **`DBOS.recv(topic?, { timeoutSeconds })`** works only inside a workflow. It reads FIFO per topic and returns `null` on timeout (default 60 s).
- **Wake-up**: an in-transaction trigger issues `NOTIFY dbos_notifications_channel`, so a `recv` never wakes before the row commits. Without LISTEN/NOTIFY it polls.
- **Events and streams**: `DBOS.setEvent` / `DBOS.getEvent` publish the latest value. `writeStream` / `readStream` also exist.

### Cancel, resume, timeout

Source: [reference/methods](https://docs.dbos.dev/typescript/reference/methods).

- **`DBOS.cancelWorkflow(id)`** sets `CANCELLED` and removes the workflow from its queue. It takes effect **at the start of the next step**. A step already running is not interrupted, but it can check `DBOS.stepStatus.cancelSignal`. In source (`#cancelWorkflows`, about line 1946), the cancel also nulls `queue_name` and `deduplication_id`, which frees the dedup id.
- **`DBOS.resumeWorkflow(id, { queueName? })`** restarts from the last completed step: at once, or re-enqueued when a `queueName` is given.
- **`DBOS.forkWorkflow(id, startStep, …)`** starts a new execution from a given step.
- **`timeoutMS`** cancels at the next step. Its clock starts at dequeue, and it is stored in the database, so it survives restarts.

## Vercel Workflow SDK [WF]

### Sending into a running workflow: hooks

Source: [foundations/hooks](https://workflow-sdk.dev/docs/foundations/hooks).

- **Creating and awaiting**: `createHook<T>({ token?, metadata? })`, then `await hook` suspends the run until a payload arrives.
- **Many payloads**: hooks are `AsyncIterable`. With `for await (const p of hook)`, "each time you call `resumeHook()` with the same token, the loop receives another value." `resumeHook(token, payload)` comes from `workflow/api`.
- **Schemas and webhooks**: `defineHook({ schema })` adds validation. `createWebhook` serves `/.well-known/workflow/v1/webhook/:token`, but webhooks cannot take custom tokens.
- **Deterministic tokens** (`` `conv:${id}` ``) are allowed for `createHook`:
  - The token is registered when the workflow suspends, not when the hook is created.
  - `await hook.getConflict()` returns the `Run` that already owns the token, or `null`.
  - `experimental_force: true` takes the token over, and the old run's `await hook` rejects with `HookForceClaimedError`.
  - `hook.dispose()` releases a token early.
- **Timeouts**: race the hook promise against `sleep("1d")`. The docs warn against racing `iterator.next()`, because the losing `next()` still consumes the event.

### Cancel and wake

- **`run.cancel({ cancelReason? })`** ([get-run](https://workflow-sdk.dev/docs/api-reference/workflow-api/get-run)) only writes a `run_cancelled` event (`packages/core/src/runtime/runs.ts`, `cancelRun`).
- **No in-workflow cancel signal yet**: the runtime treats the event as terminal on the next delivery (`packages/core/src/runtime.ts`, about line 2681). A TODO there notes there is no in-workflow cancel signal yet. Whether a running step is interrupted is unverified.
- **`run.wakeUp()`** ends pending `sleep()` calls early.

### No per-key concurrency

- **`start()`**: each call creates a new run, with no queue, concurrency or dedup option ([start](https://workflow-sdk.dev/docs/api-reference/workflow-api/start)).
- **Suggested workaround**: a deterministic hook token plus `getHookByToken()` or `getConflict()`. The docs admit this is not atomic with `start()` and suggest a durable request record for now.
- **The Postgres World** (`@workflow/world-postgres`):
  - It runs on **graphile-worker 0.16.6**.
  - Executor jobs go to a named graphile queue `` `${queue}:${runId}:executor` `` (`packages/world-postgres/src/queue.ts`, about line 288). Graphile runs one job at a time per named queue, so execution is serial **per run**, not per a key you choose.
  - Worker concurrency defaults to 50.
- **Per conversation**: the pattern available is one long-lived run per conversation, consuming a hook with a token like `conv:${id}`.

## The lecture [L]

Slides 14, 19 and 20 are summarized in short form on the slides. Here is what the talk adds, quoted:

- **The Router (slide 14, "What wakes the agent")**, at 11:53: "Then we have basically a router that ddupes that and figures out how to put it into the conversation. And then it's has this heristic of do I need to bug the user about this or not?" The Router's inputs, listed just before at 11:25–11:51, are a Slack ping, a phone call or meeting, and "some routine or some background work … and then you want to come back and give you a summary."
- **The queue (the server diagram)**, at 13:32: "commands will come in they get put into this queue and then it calls the purple box which is the agent loop … and then when you shut it down you can kind of save the state to the database or storage."
- **Hitting send (slide 19)**, at 15:42–16:17: "you send a message and you kind of want the client to immediately identify that and acknowledge it. Then when you go into the turn … saving that to the database, and then the clients are essentially putting subscriptions … listening for these signals, and if they get a signal, then they can go and essentially fetch the latest information from the server. And there's some fancy dduping you can do to make sure if you know if there were some kind of retries um that you would not show, you know, multiple messages in the the list."
- **Rules for new messages (slide 20)**, at 17:20–18:06, the passage on priority, stopping and batching:
  > "let's say a new message comes in. There's different priorities based on whether I'm messaging my agents or messaging my bots versus if it's in a group chat or a Slack thread or some background routine for example. So if I say oh actually you know change the date for this event, we actually want that agent loop to stop and my message is going to have priority over everything else that's happening which kind of makes sense. Um, for everybody else, you're kind of putting things into the queue in the back of the line. And if you're if the the agent gets, you know, three or four messages very quickly, it's able to kind of batch those together. So, it's just one turn. You can kind of figure out whatever heristic you want there. Um, and then it kind of goes through and does each turn at a time."
- **Steering (era 4)**, at 4:31–4:55: "instead of kind of queuing commands, you can steer the agent and you might say, 'Hey, go check this thread.' and then immediately after, oh, by the way, you know, actually go do that on Thursday. And prior generations of models would get kind of confused when you would immediately interrupt it and give it some other command. But now they kind of understand … The models and the harnesses can now handle that."
- **Helpers**, at 24:56–25:03: the main agent manages helpers like a to-do list: "You can go check on it. You can send it a message, you know, you can stop the helpers."

What the talk does **not** say:

- It names no batching window, cap or drop rule ("whatever heristic you want").
- It doesn't say whether the stopped loop's partial work is kept, or whether "stop" means abort-and-restart or inject.
- It doesn't say where the queue is stored. It does say the turn runs on a durable workflow, Temporal (16:53–17:14).
- The only stated priority split is between the owner's direct message, which stops the loop and jumps the line, and "everybody else", who joins the back of the queue: group chats, Slack threads and background routines.

## Our runner and Turn today [R]

### What the runner offers

- **A Postgres job table, `chat.job`** (`runner/server/db/job.ts`):
  - Jobs are claimed by `claimJob` with `update … where id = (select … where status='queued' and run_after <= now order by run_after, created_at limit 1 for update skip locked)` (`jobs/store.ts` L68–100).
  - Global FIFO by `run_after, created_at`. No priority column and no partition key.
- **Concurrency**: `inProcessRunner` runs up to `concurrency` jobs per process (default 2). It polls every `pollMs` (2 s), and `wake()` / `enqueue` claim at once (`jobs/in-process.ts` L72–117). The limit is per process. Nothing limits jobs per key.
- **`runAfter`** (`EnqueueOptions`, `jobs/runner.ts`): the earliest time a job may be claimed. The same column carries retry backoff (10 s, 1 min, 5 min; `jobs/define.ts` L88).
- **`idempotencyKey`**: a partial unique index over active jobs (`job_idempotency_key_active_idx … where status in ('queued','running')`).
  - A second enqueue with an active key is a no-op that returns the existing job's id (`enqueueJob`, `store.ts` L30–62).
  - The key is reusable once the job ends. It dedupes; it does not serialize two different keys.
- **`enqueueIn(tx, …)`**: queues a job in the caller's transaction (in-process runner only). Call `wake()` after commit (`plugin.ts`).
- **`cancel(key)` / `cancelIn(tx, key)`**: set the active job `cancelled`.
  - `cancelIn` returns `"queued"`, meaning it never runs, or `"running"`, meaning the attempt aborts "at its next heartbeat or, sooner, at its next Checkpoint, whose save is fenced" (`store.ts` L314–343).
  - Heartbeat is every 10 s, and the lease is 60 s (`JOB_TIMING`, `define.ts` L98–109).
  - The handler sees this as `ctx.signal` (an `AbortSignal`).
- **The workflow `ctx`** (`workflow/engine.ts`):
  - It offers `activity(name, fn)`, `now()`, `random()` and `patched(id)`, recorded in `chat.job_event` and replayed on retry or re-claim.
  - `activity(name, (tx) => …)` commits its write with its Checkpoint.
  - A drain (deploy `stop()`) yields at the next Checkpoint and hands the job back `queued`.
- **No messages into a running job**: there is no `send`/`recv`, signal, hook or event that delivers a message into a running workflow. The only inputs a running job gets are its payload, what it reads from the database, and the cancel through `ctx.signal`.
- **No recurring jobs**: `schedule()` throws "Recurring jobs are not supported yet" (`in-process.ts` L134–136).

### What the Turn does

Source: `bot/server/turn.ts`.

- **One Turn per Bot**:
  - `sendToBot` takes the Conversation's row lock (`select … for update`), then looks for a `bot_turn` with `status = 'running'` for the Bot.
  - If one exists it throws `CONFLICT` / `error.turnRunning`, "A Turn is still running for this Bot" (L131–145).
  - Otherwise, in the same transaction, it saves the user Message, `enqueueIn`s job `bot.turn` with `idempotencyKey: turnId`, inserts the Turn `running` with `startedAt = now + 1 ms`, and calls `wake()` after commit (L146–168).
  - The one-at-a-time rule is held by that row lock and check, not by the runner.
- **`stopBot`**, under the same row lock, calls `cancelIn(tx, turnId)`:
  - A `queued` job's Turn ends `stopped` at once, keeping whatever its Checkpoints recorded (L178–211).
  - A `running` job's Turn ends `stopped` when its attempt aborts (`stopIfCancelled`, L335–353).
  - Stop is a hard stop. No new Turn starts from it.
- **What a Turn reads**: its model input is every user Message in the Conversation with `createdAt < turn.startedAt`, plus earlier Turns' transcripts, merged by time (`modelInput`, L422–451). A Turn therefore already reads every user Message saved before it started, not only the one that created it.
- **Follow and notify**: the Turn's progress is followed through `deps.pubsub` "changed" hints with a 2 s re-read (`followPollMs`, `hintChanged`, L55–85). This is the lecture's "signal, then fetch".
- **Limits**: the wall-clock limit is `turnTimeLimitMs = 5 min` (`bot/server/store.ts` L64), and the step limit is `turnStepLimit = 10`.

### What is missing compared with the prior art

These are stated as gaps only. Whether to fill them is for #499–#501.

- **Per-key serialization**: there is no per-Conversation or per-Bot queue or partition in the runner. A second message is refused, not queued.
- **Priority**: none. The claim order is `run_after, created_at` only.
- **Delivering a message into a running Turn** (steer): there is no channel for it. The closest pieces are the Turn re-reading the database between model calls, which it does not do today because `modelInput` is read once, and `ctx.signal` for cancel.
- **Interrupt** (stop, then run the new message): only the two halves exist, `cancelIn` and a new enqueue. Nothing links them, and a running attempt only sees the cancel at its next heartbeat (up to 10 s) or Checkpoint.
- **Batching window**: no debounce or quiet window. `runAfter` can delay a job, and the `startedAt` cut-off in `modelInput` already makes a Turn read every user Message saved before it started.
- **Cap or drop policy**: none.
