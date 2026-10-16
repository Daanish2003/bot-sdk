# How open-source always-on agents work

Research for [#389](https://github.com/Daanish2003/ai-chat/issues/389) (child of map [#383](https://github.com/Daanish2003/ai-chat/issues/383)). Researched 2026-10-16. The question: how do open-source always-on agents implement what the lecture "How always-on agents work" (Lee Robinson, Stanford CS146S) describes? That means memory, the router and queue, messaging the user, heartbeats and Routines, the sandbox and computer use, and prompt-cache handling. This file holds facts and links only.

## Sources

Every source is pinned to the commit read on 2026-10-16. Docs were read from each repo's own `docs/` tree at that commit, and code from the same tree.

- **[OC]** OpenClaw, [`openclaw/openclaw`](https://github.com/openclaw/openclaw) at [`3aa6420`](https://github.com/openclaw/openclaw/tree/3aa642027ea1466c4694ad6950653c4de3740644). MIT, about 392k stars. A TypeScript "Gateway" that hosts agents behind chat channels.
- **[LC]** Letta Code, [`letta-ai/letta-code`](https://github.com/letta-ai/letta-code) at [`1297870`](https://github.com/letta-ai/letta-code/tree/1297870b0aa6662d6c70729d273f5073c1bcbdea). Apache-2.0. This is the current Letta.
- **[LV1]** The retired Letta V1 / MemGPT server: [`letta-ai/letta`](https://github.com/letta-ai/letta), `archive` branch, at [`56ba9c2`](https://github.com/letta-ai/letta/tree/56ba9c25552605eec89de8ed3dc6394b625c1993). It is used here only for history.
- **[HA]** Hermes Agent, [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) at [`70eb065`](https://github.com/NousResearch/hermes-agent/tree/70eb065405cd4b382917ac683f59a8233c83ccbf). MIT, about 254k stars. Python.
- **[OB]** OpenBOT, [`ashhart/OpenBot`](https://github.com/ashhart/OpenBot) at [`b544cb7`](https://github.com/ashhart/OpenBot/tree/b544cb743986193fdc3d234ae66c8e44ef68fc00). MIT, 30 stars. "A reimplementation of GrokBot".
- **[OG]** Open GrokBot, [`ishandutta2007/open-grokbot`](https://github.com/ishandutta2007/open-grokbot) at [`c2efde8`](https://github.com/ishandutta2007/open-grokbot/tree/c2efde8b29a081d35e0306cff65699ce8c8b5917). MIT, 9 stars. "Open source equivalent of grok bot".

Short links below are relative to these commits: `OC docs/…`, `LC src/…`, `HA website/docs/…`.

## Headline facts

1. **Letta's famous repo is no longer Letta.** `letta-ai/letta` `main` is a landing page. Its `AGENTS.md` says: "Do not infer current Letta behavior from this repository". The current harness is `letta-ai/letta-code`, a TypeScript CLI, App Server and set of channels ([LV1 README](https://github.com/letta-ai/letta/blob/5bcdd177d70fa2b31a754cfcd801e77b2e1ab16a/README.md), [AGENTS.md](https://github.com/letta-ai/letta/blob/5bcdd177d70fa2b31a754cfcd801e77b2e1ab16a/AGENTS.md)). Treat the classic MemGPT tiers (core, recall and archival memory, `send_message`, `request_heartbeat`) as history.
2. **All three mature projects keep memory as plain files and freeze the prompt for the session.** OpenClaw uses `MEMORY.md`, `USER.md` and `memory/YYYY-MM-DD.md`. Hermes uses `MEMORY.md` and `USER.md`. Letta Code uses a git-backed `MemFS`. Hermes and Letta Code both say outright that a memory edit made mid-session does not change the current prompt, which protects the prefix cache.
3. **"Only speak through a tool" exists, but as an option.** Letta Code's `MessageChannel` tool says "A normal assistant response is not delivered back to the external channel automatically." OpenClaw's `visibleReplies: "message_tool"` mode does the same for group rooms. Otherwise the convention is a silence token: `NO_REPLY` in OpenClaw and Hermes, and `[SILENT]` in Hermes.
4. **Neither "grokbot" clone is a server-side always-on agent.** OpenBOT is a local macOS Electron app. Open GrokBot is a roughly 2k-line FastAPI scaffold: its "memory" is the last 100 messages in a Redis list, and it has no scheduler.

---

## OpenClaw [OC]

### Memory

- **Tiers, all Markdown in the agent workspace (default `~/.openclaw/workspace`).** `USER.md` holds directives about the user and has its own 4,000-character cap. `MEMORY.md` holds curated long-term facts. Both load at session start. `memory/YYYY-MM-DD.md` daily notes are "indexed for `memory_search` and `memory_get`, but are not injected into the bootstrap prompt on every turn". `DREAMS.md` is a human-review diary. "The model only remembers what gets saved to disk; there is no hidden state." ([docs/concepts/memory.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/memory.md)) Bootstrap files are truncated when injected: 20,000 characters per file and 60,000 in total by default ([docs/concepts/agent-workspace.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/agent-workspace.md)).
- **Files plus a database index.** The default `memory-core` engine is "SQLite-based" with keyword, vector and hybrid search. Plugins add Honcho, LanceDB and a `memory-wiki` layer. The agent's tools are `memory_search`, `memory_get` and `intent` (event-conditioned standing intents) ([memory.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/memory.md)).
- **Updates come in three passes.**
  1. **In-turn:** the agent writes notes when asked ("Remember that I prefer TypeScript").
  2. **Pre-compaction memory flush:** "Before compaction summarizes your conversation, OpenClaw runs a silent turn that reminds the agent to save important context." The flush runs on a private copy of the conversation and may only _append_ new text to the daily note. It is on by default, and it can be pointed at a cheap local model with `compaction.memoryFlush.model` ([memory.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/memory.md)).
  3. **Dreaming:** a background consolidation sweep. It is on by default and runs as one managed cron job at `0 3 * * *`. Its phases are Light (stage), REM (themes) and Deep (promote to `MEMORY.md`). Deep promotion must pass `minScore`, `minRecallCount` and `minUniqueQueries`. A "tool-free completion" then returns add, merge or supersede _decisions_, which a writer applies, with a fallback to append-only. Candidates marked `untrusted` or `system` are removed before the prompt is built (a "taint gate"). Only interactive sessions are ingested; cron, heartbeat and subagent sessions are excluded. The design cites sleep-time compute (arXiv:2504.13171) and Generative Agents ([docs/concepts/dreaming.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/dreaming.md)).
- **Ranking for promotion.** Deep ranking weights relevance at 0.30, frequency 0.24, query diversity 0.15, recency (time-decayed) 0.15, multi-day consolidation 0.10 and conceptual richness 0.06. Light and REM hits add a "small recency-decayed boost". Each promoted entry gets `<!-- importance: N -->` (1 to 10) and up to three `<!-- trigger: … -->` tags ([dreaming.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/dreaming.md)).
- **Ranking for retrieval, and decay.** Vector search and BM25 run in parallel and are merged, then scored as `hybrid relevance × recency decay × importance multiplier`, then reordered by MMR (lambda `0.7`, Jaccard over snippet tokens). "Dated daily notes decay with a 30-day half-life; curated files such as `MEMORY.md` and `USER.md` are evergreen." `minScore` is applied _before_ decay, so decay changes the order but not whether a hit qualifies ([docs/concepts/memory-search.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/memory-search.md)).
- **Escalated recall.** "Active Memory" runs a blocking recall sub-agent only when a message asks about the past and the rule-based lane found no strong match ([docs/concepts/active-memory.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/active-memory.md)).

### Router and queue

- **Inbound dedupe:** "an in-memory cache keyed by agent scope, channel route (channel + peer + account + thread), and message id". Entries expire after 20 minutes or once 5,000 are tracked.
- **Inbound debounce:** rapid text from one sender is batched into one turn. It is configured with `messages.inbound.debounceMs`; the example values are 1,500 ms for Discord and Slack and 5,000 ms for WhatsApp, and Telegram defaults to a 300 ms quiet window. Media flushes immediately ([docs/concepts/messages.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/messages.md)).
- **Queue:** "A lane-aware FIFO queue". Each session has its own lane (`session:<key>`), so only one turn runs per session. Lanes feed a global `main` lane whose concurrency is capped by `agents.defaults.maxConcurrent`. **Priority:** "foreground work can overtake normal work by up to 15 seconds and background work by up to 30 seconds … running turns are never preempted." ([docs/concepts/queue.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/queue.md))
- **Messages that arrive mid-run:** the `/queue` modes are `steer` (the default; inject into the active run at the next model boundary), `followup`, `collect` (merge queued messages into one follow-up turn after a quiet window) and `interrupt`. The defaults are a 500 ms debounce, `cap: 20` and `drop: "summarize"` ([queue.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/queue.md)).

### Messaging the user and staying quiet

- **Default:** the final reply is delivered automatically. **Silence:** "Only a completed final whose entire text is uppercase `NO_REPLY` … requests silence." Variants such as `no_reply` and `NO_REPLY.` count as visible text. "`NO_REPLY` discards anything written this turn that was not sent" ([messages.md#silent-replies](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/messages.md)).
- **SendToUser-style mode:** `messages.groupChat.visibleReplies: "message_tool"`, or `messages.visibleReplies` to apply it globally. "Visible answers must go through `message(action=send)`." If the model returns final text without calling the tool, "OpenClaw keeps that text private". This is recommended for "ambient always-on rooms" combined with `unmentionedInbound: "room_event"` ([docs/channels/groups.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/channels/groups.md), [docs/channels/ambient-room-events.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/channels/ambient-room-events.md)).

### Heartbeats and Routines

- **Heartbeat:** "periodic agent turns in the main session so the model can surface anything that needs attention without spamming you". The default cadence is `30m`, or `1h` with Anthropic OAuth. The default prompt ends "If nothing needs attention, reply NO_REPLY." The legacy `HEARTBEAT_OK` acknowledgment is still accepted, and a reply with at most 300 characters around it is dropped. Options include `lightContext` (skip bootstrap files), `isolatedSession` (no history) and `activeHours`. Event-driven wakes, such as a finished background exec, are rate-limited to one per 30 s, with a flood guard after 5 starts in 60 s. Transcript markers such as `[OpenClaw heartbeat poll]` record what woke the agent. The heartbeat checklist now lives in the database ("monitor scratch"); the runtime no longer reads `HEARTBEAT.md` ([docs/gateway/heartbeat.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/gateway/heartbeat.md)).
- **Routines are called "Automations"** (`openclaw automations`, alias `openclaw cron`). The available triggers are schedules, webhooks and Gmail PubSub. They "run inside the Gateway process, not inside the model", and their jobs and history persist in SQLite. On restart, overdue jobs are rescheduled rather than replayed. A run without a recorded terminal result is marked interrupted, with delivery Unknown, and is not re-run. Isolated runs re-prompt once if the first result is only "on it" ([docs/automation/cron-jobs/how-it-works.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/automation/cron-jobs/how-it-works.md)).

### Sandbox and computer use

- **The Gateway itself always runs on the host.** "Only tool execution moves into the sandbox when enabled." The sandbox is off by default. `mode` is `off`, `non-main` or `all`; `scope` is `agent`, `session` or `shared` (one container per agent, per session, or shared). The backends are Docker, Podman, SSH, OpenShell and Crabbox ([docs/gateway/sandboxing.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/gateway/sandboxing.md), [modes-scope-and-backend.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/gateway/sandboxing/modes-scope-and-backend.md)). The sandboxed browser is reached over CDP and can be watched through password-protected noVNC ([docker-backend.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/gateway/sandboxing/docker-backend.md)).
- **Cloud sessions:** the Gateway keeps the transcript, workspace and credentials, while work runs on a paired device or a leased Crabbox cloud worker. `suspendAfter: "2h"` reconciles the workspace and then releases the machine; "the next message provisions a replacement automatically". Model credentials never reach the remote machine ([docs/gateway/cloud-sessions.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/gateway/cloud-sessions.md)).
- **Computer use:** one `computer` tool (`computer.act` and `screen.snapshot`) controls the Gateway's desktop, a paired node, or a cloud session's desktop. The providers are Peekaboo and CUA. A human can take control, which pauses agent input ([docs/nodes/computer-use.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/nodes/computer-use.md)).

### Prompt-cache handling

- **System prompt split at an internal cache boundary.** Stable content goes above it: Project Context, workspace instructions and fixed policy. Tool catalogs, skills, memory recall and the sandbox section go below it. "Refreshing a catalog or changing granted tools therefore leaves the cached workspace prefix byte-identical". On direct Anthropic and OpenAI Responses routes, refreshed sections are appended as messages after the current user turn. The date and time zone travel in a per-turn runtime-context message, so "Day rollover therefore leaves the complete system prompt and prior conversation bytes unchanged" ([docs/concepts/system-prompt.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/system-prompt.md)).
- **Cache-TTL pruning:** old tool results are pruned only after the provider's cache TTL expires (5 m by default, 1 h seeded by the Anthropic plugin). Direct Anthropic API-key requests use server-side clearing. The Anthropic plugin also sets the heartbeat cadence (`30m` with an API key, `1h` with OAuth) next to the `1h` cache TTL ([docs/concepts/session-pruning.md](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/session-pruning.md)).

---

## Letta Code [LC] (current Letta)

### Memory

- **Memory blocks** are "editable segments of the system prompt", kept under `system/` in MemFS. **External memory**, meaning skills, Markdown and other files, lives outside the prompt and is discovered through `[[path]]` links in blocks. **Recall memory** is message history; it "is NEVER injected" and is searched on demand ([src/agent/prompts/letta_local_memfs.md](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/agent/prompts/letta_local_memfs.md)).
- **Storage is files tracked in git:** `~/.letta/agents/<agentId>/memory/`, with `system/` as the in-prompt directory ([src/agent/memory-filesystem.ts](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/agent/memory-filesystem.ts)). "Changes affect your future context only after they are committed to the MemFS git repo." A pre-commit hook validates the YAML frontmatter, which needs a `description:`. With Letta Cloud, the agent state is stored server-side ([README](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/README.md)).
- **Post-turn update pass ("dreaming" / reflection):** "Background subagents review recent conversations, consolidate useful lessons, and update memory without interrupting active work". It runs "after a set number of completed agent steps or when the context window is compacted" ([docs.letta.com/letta-code/memory](https://docs.letta.com/letta-code/memory)). In code, the triggers are `off`, `step-count` and `compaction-event`. The default is `compaction-event`, and the step count defaults to `25` ([src/cli/helpers/memory-reminder.ts](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/cli/helpers/memory-reminder.ts)). Memory workers edit a private git worktree that is merged back afterwards. Automatic client-side dreaming is off by default on native Windows ([README](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/README.md)).
- **Ranking and decay:** I found none in the sources. Blocks are kept lean by instruction ("Keep blocks lean"), and `/doctor` flags an oversized system prompt.

### Router and queue

- **Channels** are plugins (Telegram, Slack, Discord, and custom ones under `~/.letta/channels/<id>/`). Each has routing JSON and a DM policy of `pairing`, `allowlist` or `open` ([src/channels/README.md](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/channels/README.md)). A channel account has an `inboundDebounceMs` setting ([src/channels/accounts.ts](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/channels/accounts.ts)).
- **Queue:** the gateway serializes deliveries per agent runtime through a promise chain (`state.submissionQueue`), and a delivery is marked `submitting` or `queued` ([src/channels/gateway-core.ts](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/channels/gateway-core.ts)). I found no priority scheme.

### Messaging the user and staying quiet

- **`MessageChannel` tool:** "When you receive a `<channel-notification>`, use this tool to reply … A normal assistant response is not delivered back to the external channel automatically." It has a reply mode (`chat_id`) and a proactive mode (`target`) ([src/tools/descriptions/MessageChannel.md](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/tools/descriptions/MessageChannel.md)). Staying quiet therefore means not calling the tool.
- **Duplicate-send guard:** an adjacent identical send within a turn is suppressed with an error, so that "the agent receives explicit feedback instead of a false success" ([src/channels/message-channel-idempotency.ts](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/channels/message-channel-idempotency.ts)).

### Heartbeats and Routines

- **Schedules:** set with `--cron`, `--every` or `--at` plus `--prompt`; the agent can also create them itself. "Each run starts a new conversation by default." `--conversation default|<id>|self` targets an existing conversation instead. Cloud schedules "fire from a server-side timer and run in the managed cloud sandbox". Local schedules are stored in `~/.letta/crons.json` and run only while a Letta process is open. If the machine is offline, the run falls back to the Cloud sandbox ([docs.letta.com/letta-code/scheduling](https://docs.letta.com/letta-code/scheduling)).
- **Scheduled-run prompt:** a fire is wrapped in a `<system-reminder>` that says: "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory". Conversations it creates are tagged `origin:schedule` ([src/cron/scheduled-task-prompt.ts](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/cron/scheduled-task-prompt.ts)).
- **Heartbeats:** the README says "Configure heartbeats and crons", but the scheduling docs page does not describe heartbeats. The `heartbeat` hits in the source are connection and lease keep-alives, not agent wakes. I could not verify a distinct agent-heartbeat feature.
- **History [LV1]:** in MemGPT, `request_heartbeat` was a parameter on every tool: "Request an immediate heartbeat after function execution … to chain multiple tools together". That made it a loop-continuation flag, not a timer ([letta/constants.py](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/constants.py)). The base tools were `send_message` ("Sends a message to the human user"), `conversation_search`, `archival_memory_insert` and `archival_memory_search`, along with `core_memory_*` and `memory_*` edits ([letta/functions/function_sets/base.py](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/functions/function_sets/base.py)).

### Sandbox and computer use

- **Agent state lives in Letta Cloud,** and the harness runs on "a laptop, GitHub Actions, a Cloud sandbox, or a remote computer". `letta server --computer-name "…"` registers a machine, and `--computer cloud` starts or reuses the agent's cloud sandbox ([README](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/README.md)). I did not find a desktop or computer-use tool in the sources I read.

### Prompt-cache handling

- **The prompt is compiled once per conversation.** "Editing memory does NOT change your behavior in the current turn. The prompt governing this turn is the one compiled at the start of the conversation; a memory edit is applied on a later recompile" ([letta_local_memfs.md](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/agent/prompts/letta_local_memfs.md)). I found no explicit `cache_control` handling in `src/`.

---

## Hermes Agent [HA]

### Memory

- **Two bounded files** in `~/.hermes/memories/`: `MEMORY.md`, capped at 2,200 characters (about 800 tokens), and `USER.md`, capped at 1,375 characters (about 500 tokens). Both are "injected into the system prompt as a frozen snapshot at session start". "Memory does **not** auto-compact": a write that goes over the limit returns an error, and the agent must consolidate. Past sessions are stored in SQLite (`~/.hermes/state.db`) with an FTS5 index and searched through `session_search` ([website/docs/user-guide/features/memory.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/memory.md)).
- **Post-turn update pass:** "After a turn, the background self-improvement review may quietly save a memory or update a skill." It runs on the main model by default, "replaying the conversation — which is already warm in the prompt cache, so it's cheap cache reads". When `auxiliary.background_review` names a cheaper model, it replays a compact digest instead. `write_approval: true` stages writes for `/memory pending`. A chat notification such as `💾 Memory updated` is shown by default ([memory.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/memory.md)).
- **Ranking and decay:** none for the two files, which are capped and curated by hand. External providers such as Honcho are plugins.

### Router and queue

- **Busy session:** the base adapter queues the message in `_pending_messages` and sets an interrupt event. The gateway runner intercepts commands such as `/stop`, `/new` and `/queue`. Each session's busy mode is `interrupt`, `steer` or `queue`, and there is a per-session FIFO with persisted `pending_submissions` ([website/docs/developer-guide/gateway-internals.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/developer-guide/gateway-internals.md)). A messaging chat is "one continuous session that survives restarts" ([memory.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/memory.md)).

### Messaging the user and staying quiet

- **Final replies go to the chat.** A heartbeat turn "may end with a bare silence marker (`NO_REPLY` / `[SILENT]`): the gateway sends nothing". During heartbeat work, no typing indicator or progress bubble is posted ([heartbeat.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/heartbeat.md)). A `send_message` tool exists for cross-session sends (`gateway/mirror.py`, per [gateway-internals.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/developer-guide/gateway-internals.md)).

### Heartbeats and Routines

- **`/heartbeat every <interval> <prompt>`** sets one heartbeat per session, with a minimum interval of 60 s. It fires "as a normal user turn — same conversation, same context, same prompt cache". It is idle-only and never interrupts a running turn. Missed ticks coalesce into one, queued user messages win, and its state persists in `SessionDB.state_meta` under `heartbeat:<session_id>`. A "Don't-invent-work guard" tells the agent to reply briefly when nothing changed ([website/docs/user-guide/features/heartbeat.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/heartbeat.md)).
- **`hermes cron`:** each run gets "a fresh isolated session per tick". Jobs are stored in `~/.hermes/cron/jobs.json`. Results are delivered to the origin chat, a file or a platform. Webhooks can trigger a job, and a script-only `no_agent` mode makes no LLM call. Delivery is recorded against a fire identity, so a restart does not re-run the agent ([website/docs/user-guide/features/cron.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/cron.md)).

### Sandbox and computer use

- **"Seven terminal backends — local, Docker, SSH, Singularity, Modal, Daytona, and Vercel Sandbox."** "Daytona and Modal offer serverless persistence — your agent's environment hibernates when idle and wakes on demand" ([README.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/README.md)).

### Prompt-cache handling

- **Anthropic `cache_control` "system_and_3":** breakpoint 1 is the system prompt, and the other three are a rolling window over the last three non-system messages. The TTL defaults to `5m`, with `1h` available. After compression, "the system prompt cache survives" ([website/docs/developer-guide/context-compression-and-caching.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/developer-guide/context-compression-and-caching.md)).
- **Frozen memory snapshot:** "never changes mid-session. This is intentional — it preserves the LLM's prefix cache". The heartbeat makes "No system-prompt mutation, no toolset change" ([memory.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/memory.md), [heartbeat.md](https://github.com/NousResearch/hermes-agent/blob/70eb065405cd4b382917ac683f59a8233c83ccbf/website/docs/user-guide/features/heartbeat.md)).

---

## The "grokbot" clones

### OpenBOT [OB]

From the [README](https://github.com/ashhart/OpenBot/blob/b544cb743986193fdc3d234ae66c8e44ef68fc00/README.md) unless noted.

- **What it is:** "A local-first, open-source desktop agent chat app" (Electron, macOS) that "drives the agent CLIs you already have installed": `claude`, `codex`, `opencode`, `pi` and `droid`. It can also call provider APIs directly. All data is JSON files on disk.
- **Memory:** a per-bot `remember` tool stores one fact per call, capped at 2,000 characters and 500 entries per bot. Every save goes through the approval gate ([src/main/tools/agent/memory.ts](https://github.com/ashhart/OpenBot/blob/b544cb743986193fdc3d234ae66c8e44ef68fc00/src/main/tools/agent/memory.ts)).
- **Routines:** "Record a sequence of tool calls … then replay it as a normal, cancellable turn". This is the lecture's "learn by watching". An in-app scheduler ticks every 30 s and runs each routine in a `Scheduled: <name>` session ([src/main/routines/scheduler.ts](https://github.com/ashhart/OpenBot/blob/b544cb743986193fdc3d234ae66c8e44ef68fc00/src/main/routines/scheduler.ts)). "Closing or suspending the Mac stops local work."
- **Sandbox and computer use:** each managed bot gets "a separate Virtualization.framework VM" through Apple's `container` runtime, with a persistent workspace, a Chromium profile and an Openbox/X11 desktop. A human can take over for SSO, 2FA or CAPTCHA, and the bot's turn pauses until control is handed back. Host computer use (macOS `screencapture` and `osascript`) needs an approval card for every action. "Local shell and file tools are not sandboxed" when the target is "This Mac".
- **Multi-bot:** turns are passed with a text protocol, `ACTION: SPEAK | ASK | YIELD | FINAL`.
- **Not found:** a heartbeat, a silence token or prompt-cache handling.

### Open GrokBot [OG]

- **What it claims:** "always-on AI agent … 24/7", with a Next.js and FastAPI stack plus Postgres, Redis, MinIO and Docker sandboxes ([README](https://github.com/ishandutta2007/open-grokbot/blob/c2efde8b29a081d35e0306cff65699ce8c8b5917/README.md)).
- **What the code does:** the backend is about 2,100 lines of Python. "Memory" is `rpush` plus `ltrim(key, -100, -1)` on a Redis list `memory:{bot_id}:{conversation_id}`, with an in-process dict as fallback ([backend/app/services/memory.py](https://github.com/ishandutta2007/open-grokbot/blob/c2efde8b29a081d35e0306cff65699ce8c8b5917/backend/app/services/memory.py)). The sandbox is one long-lived Docker container per bot (`grokbot_sandbox_{bot_id}`, `tail -f /dev/null`), with no snapshot or sleep ([backend/app/services/sandbox.py](https://github.com/ishandutta2007/open-grokbot/blob/c2efde8b29a081d35e0306cff65699ce8c8b5917/backend/app/services/sandbox.py)). Redis is used for pub/sub broadcasts. I found no scheduler, heartbeat or silence path in `backend/app`.
- **Note:** the repo description says "grok bot by Cursor" and the README says "x.ai's Grok Bot". The lecture slides show "Grok Bot" and "grokbot.app".

---

## Side by side

| Concern                 | OpenClaw                                                                  | Letta Code                                          | Hermes Agent                                | OpenBOT                              |
| ----------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| Always-in-prompt memory | `USER.md` + `MEMORY.md` (truncated to budget)                             | `system/` memory blocks                             | `MEMORY.md` 2,200 ch + `USER.md` 1,375 ch   | none found                           |
| On-demand memory        | dated daily notes, sessions (hybrid search)                               | external MemFS files, recall search                 | `session_search` (SQLite FTS5)              | `remember` entries                   |
| Store                   | Markdown + SQLite index                                                   | Markdown in git (+ Cloud)                           | Markdown + SQLite                           | JSON                                 |
| Post-turn update        | pre-compaction flush + nightly dreaming                                   | reflection subagents (compaction or every 25 steps) | background review after a turn              | none found                           |
| Ranking and decay       | relevance × 30-day half-life × importance, MMR                            | none found                                          | none (capped files)                         | none                                 |
| Queue                   | per-session lane, priority head start 15 s / 30 s, steer, collect         | per-runtime promise chain                           | per-session FIFO, interrupt / steer / queue | n/a                                  |
| Dedupe and batch        | message-id cache 20 min; debounce per channel                             | `inboundDebounceMs`; duplicate-send guard           | persisted pending submissions               | n/a                                  |
| Speak-only-via-tool     | opt-in `visibleReplies: "message_tool"`                                   | `MessageChannel` (always, on channels)              | no; `send_message` for cross-session        | no                                   |
| Silence                 | `NO_REPLY` (exact)                                                        | don't call the tool                                 | `NO_REPLY` / `[SILENT]` on heartbeats       | n/a                                  |
| Heartbeat               | main-session turn every 30 m / 1 h                                        | not verified                                        | `/heartbeat` per session, idle-only         | no                                   |
| Routines                | Automations: cron, webhook, Gmail; SQLite                                 | `--cron/--every/--at`; cloud timer                  | `hermes cron`, fresh session per run        | recorded tool sequences, 30 s ticker |
| Sandbox                 | Docker/Podman/SSH/OpenShell/Crabbox; cloud workers suspend after idle     | Cloud sandbox or registered computers               | 7 backends; Modal/Daytona hibernate         | Apple VM per bot                     |
| Computer use            | `computer` tool (Peekaboo or CUA)                                         | not found                                           | not checked                                 | macOS host + VM desktop              |
| Prompt cache            | stable prefix above a boundary; date in per-turn message; prune after TTL | prompt compiled per conversation                    | `system_and_3` breakpoints; frozen snapshot | not found                            |

## Gaps and things I could not verify

- **Letta Code heartbeats:** the README mentions them, but neither the scheduling docs nor the code I searched shows an agent-level heartbeat.
- **Letta Code prompt caching:** no explicit handling found in `src/`. Caching may happen server-side in Letta Cloud, which is not open source.
- **Hermes computer use:** not checked.
- **OpenClaw memory internals:** I read the docs, not the TypeScript implementations, so weights and thresholds are as the docs state them.
- **Other projects seen but not read:** [`beclab/Olares`](https://github.com/beclab/Olares) ("Personal Cloud OS for Always-On Agents") and [`agent-substrate/always-on-agent`](https://github.com/agent-substrate/always-on-agent), a gateway plus suspendable per-conversation actors "built on OpenClaw".
