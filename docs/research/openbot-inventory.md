# OpenBot feature inventory

Research for issue #956 (child of the map #953). Researched on 2026-10-29.

**Question.** What does OpenBot do, feature by feature, and does our Bot have each feature? Cover agent teams (shared channels, handoff, review, shared files), the task queue (pause, resume, cancel, steer), provider failover, existing plans and ACP agents as providers, the built-in browser, the mobile apps and plugins.

**Sources.** The OpenBot repo [`nightly-labs/openbot`](https://github.com/nightly-labs/openbot) at `main` [`7c34614e`](https://github.com/nightly-labs/openbot/tree/7c34614e) (2026-10-29), read through `gh api`: `README.md`, `docs/glossary.md`, `docs/architecture/channels-and-messaging.md`, `docs/architecture/agents.md`, `docs/architecture/providers.md`, `docs/architecture/skills-and-plugins.md`, `docs/self-hosted-server.md`, `docs/provider-terms.md` and `CHANGELOG.md`. Also [openbot.run](https://openbot.run/), [/plugins](https://openbot.run/plugins), [/guides](https://openbot.run/guides) and [/changelog](https://openbot.run/changelog) (latest release 0.53.2, 2026-10-28). No code was cloned or run. Our side was judged from `CONTEXT.md` and `packages/botsdk/` at `main` `eb6bfc6d`.

**What OpenBot is.** "A local-first desktop workspace for persistent AI teammates" (README). It is an Electron app that runs provider CLIs (Codex App Server, Claude Code through the Claude Agent SDK, and Grok, OpenCode, Gemini, Cursor, Cline and custom agents through ACP) as persistent agents, each with its own workspace folder and conversation. A computer that runs agents is a **server**. Other people join it as members, through the desktop app, the iPhone and Android apps or the `openbot.run/app` web client, over WebRTC (README, "Architecture"). It is a development preview: agents run with `danger-full-access` and `approvalPolicy: never` (README). The license is PolyForm Noncommercial 1.0.0.

---

## Summary

| Feature                                                         | OpenBot                                                            | Our Bot                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Channels (shared multi-agent chat, with a lead and task owners) | Yes                                                                | **Missing**                                                   |
| Agent-to-agent messages (`send_message`, replies, steering)     | Yes                                                                | **Missing**                                                   |
| Handoff (delegate, transfer ownership, reassign)                | Yes                                                                | **Partial**: only to a Helper                                 |
| Review                                                          | Partly: only memory review and per-section review of an agent edit | **Have** something different (Auto-review)                    |
| Shared files between agents                                     | Yes                                                                | **Partial**: shared Computer and Knowledge, no transfer       |
| Shared data tables                                              | Yes                                                                | **Missing**                                                   |
| Human team members, roles and agent access                      | Yes                                                                | **Missing**                                                   |
| Task queue with pause, resume, cancel and edit                  | Yes                                                                | **Partial**: queue and Stop, nothing per item                 |
| Steer a running turn                                            | Yes                                                                | **Partial**: a new Message interrupts the Turn                |
| Side threads (several conversations per agent)                  | Yes                                                                | **Missing** (on purpose: one Conversation)                    |
| Provider failover (backup models)                               | Yes                                                                | **Missing**                                                   |
| Existing plans as providers                                     | Yes: ChatGPT, Claude, Gemini, Grok, Cursor and Cline plans         | **Partial**: ChatGPT plan only                                |
| ACP and coding-agent CLIs as providers                          | Yes                                                                | **Missing**                                                   |
| Local and custom endpoints                                      | Yes: Ollama, LM Studio, OpenAI-compatible                          | **Have**: Ollama and others through TanStack AI               |
| Built-in browser                                                | Yes: embedded and persistent, with named profiles                  | **Partial**: a Screen's Chrome, through a Computer-use Helper |
| Computer use                                                    | Yes: optional `cua-driver`                                         | **Have**: Computer-use Helper                                 |
| Mobile companion apps                                           | Yes: iPhone and Android, Live Activity, push                       | **Missing**                                                   |
| External messaging (Slack, Discord, Telegram)                   | Yes, with an orchestrator agent                                    | **Partial**: email only                                       |
| Plugins and marketplace                                         | Yes: 30 plugins, plus marketplace agents and skills                | **Partial**: the Host's MCP Connections, no catalog           |
| Skills                                                          | Yes                                                                | **Have**                                                      |
| Memory                                                          | Yes, with background review                                        | **Have**; no background review                                |
| Routines (schedule and webhook)                                 | Yes                                                                | **Have**                                                      |
| Routine flows and Workflows (multi-agent graphs)                | Yes                                                                | **Missing**                                                   |
| Compaction                                                      | Yes                                                                | **Have** (Summary)                                            |
| Vault and secrets                                               | Yes                                                                | **Have** (Secret)                                             |
| Self-hosting                                                    | Yes: headless Linux server and Docker                              | **Have**, differently: the SDK runs in a Host                 |

The details follow. A source path without a host is in the OpenBot repo.

---

## 1. Agent teams

OpenBot's site sells this first: agents "send each other messages, hand off tasks and share files" ([openbot.run](https://openbot.run/)). The home-page demo shows "a team of four agents, each on a different provider". In it, "the lead agent plans a launch, sends work to its teammates, asks you a question and answers with a table and a diagram" (`CHANGELOG.md`). The product word is **agent**, and "**teammate** is prompt and marketing text, never a type" (`docs/glossary.md`). OpenBot has two ways for agents to work together: direct messages, and channels.

### 1a. Agent-to-agent messages

- Every agent has the direct tools `list_agents` and `send_message` (`docs/architecture/providers.md`, "Built-in tool discovery"). The reply format and "the rule against acknowledgement loops come with each teammate message" (`agent/delivery-content.ts`, cited there).
- Agent messages carry "replies, reactions, images, and managed file transfers" (README, "What works"). They show in the chat with their reply context (openbot.run changelog 0.50.0).
- An incoming agent message steers the running turn when the receiving agent is set to steer busy messages. The user can also "steer a teammate's answer into the running turn with Steer in the 'Waiting for replies'" view (`CHANGELOG.md`).
- An answer to a request from a side thread returns to that thread (openbot.run changelog 0.52.0).

**Ours: missing.** No tool lets one Bot message another. A Trigger's `source` is one of `user`, `routine`, `check_in` or `helper` (`packages/botsdk/bot/src/storage/bot/bot-trigger.ts`). `CONTEXT.md` lists "another agent" as a Trigger source, but nothing implements it. Bots share Profiles, the Computer and Knowledge, and nothing else.

### 1b. Channels (shared multi-agent chats)

A **channel** is "the shared multi-agent chat" (`docs/glossary.md`). From `docs/architecture/channels-and-messaging.md`, "Shared channel chats":

- **Shape.** A channel has one host, a purpose, participating agents, "a selected lead", and linked agent conversations. Agent membership sets who can get work. It does not limit human access: every member of the server can read and use its channels.
- **Storage.** `ChannelStore` keeps the transcript, configuration, tasks, assignments, summaries, execution threads and read positions in SQLite. Messages have stable IDs and per-channel sequences, and the projection can be rebuilt from events. Archive stops the work and keeps the records; Restore reopens the channel.
- **One execution thread per channel and agent.** "Each channel-agent pair has a separate execution thread". The agent's normal thread is never replaced.
- **Routing to one owner.** `ChannelService` picks one owner without a model when it can: a named recipient, the task a reply is attached to, a clear follow-up to the only open task, or a channel with one member. Otherwise the lead's model routes the request, in a separate session with no work tools, from a result schema and the channel summary. It can pick a task, ask a question, or say that no work is needed. Bad routing "cannot broadcast a request". A channel with no lead stops with `channelLeadRequired`.
- **Handoff.** "Channel tools retrieve history, assign a child task, transfer ownership, and report results." A child task keeps its parent's owner, and a transfer changes it. Completed child results are combined before the owner answers. The limits are eight automatic assignments per root request, and two active assignments per channel (`CHANNEL_PARALLEL_LIMIT`).
- **Controls.** "Stop, Resume, Reassign, Archive, and Restore" (README). Stop pauses a task and its descendants and interrupts the work. Reassign waits for the old assignment to stop. Task revisions stop an old assignment from completing a corrected request.
- **Context per turn.** Each turn gets bounded channel context: the purpose, responsibilities, the current request, source messages, shared decisions, recent messages and attachment references. A versioned summary covers older messages, and the full messages stay retrievable with `channel_history`. "Agent memories keep their existing meaning". A channel also has memories and routines of its own.
- **Self-management.** A member can change its channel "when a person asks": `channel_add_member`, `channel_remove_member`, `channel_set_instructions` and the `channel_*_routine` tools. A request written only by an agent or by a routine run is refused, "so untrusted run input cannot change the channel". Each change writes a `channel-change` activity note.
- **Concurrency.** An agent runs one main-lane turn at a time: its chat, a channel delivery or a messaging delivery. A channel assignment holds only the agent that does it. Only declared `browser` and `workspace:<path>` resources are serialized between agents.
- **Interaction in a channel.** `ask_ui` questions, plan cards and `html_render` are copied into the channel, so any member can answer them. Screen capture in a channel turn always asks first.
- **Failover inside a channel.** An agent that owns waiting channel work and reaches its usage limit "moves to its backup model as for its own chat".

**Ours: missing.** Our word **Channel** means something else: "anything that sends to a Bot or shows what it sends" (`CONTEXT.md`). A later ticket that names a "Team" should not reuse "Channel" for OpenBot's idea. OpenBot's channel would be a group Conversation with several Bots, a lead that routes, and tasks with owners. `CONTEXT.md` expects this: a Bot "can work across others, such as group chats later".

### 1c. Handoff

OpenBot has three kinds of handoff:

1. **In a channel**: assign a child task, transfer ownership, or Reassign (above).
2. **Routine flows**: "a routine flow hands the answer of an agent routine on to other agents", drawn on a canvas for each agent. A handoff is a mailbox delivery from the routine (`RoutineScheduler.enqueueHandoff`), and agents edit flows with `connect_routine_agents` and `disconnect_routine_agents` (`docs/architecture/agents.md`, "Routine flows").
3. **Workflows**: a graph of steps that can name several agents, models, conditions, approvals and outputs, with schedule and webhook triggers and version history. An agent step is a routine handoff (`docs/glossary.md`; `docs/architecture/agents.md`, "Workflows"; openbot.run changelog 0.50.0).

OpenBot also uses "handoff" for context passed between sessions of the same agent. A routine session reads "a short handoff of the newest chat messages", and a new provider session of a side thread gets a handoff (`docs/architecture/agents.md`).

**Ours: partial.** A Bot can hand one complete task to a **Helper**, which reports back as a Trigger (`CONTEXT.md`). A Helper belongs to its Bot and "is never a Bot itself". No Bot can hand work to another Bot, and we have no flows or workflows.

### 1d. Review

The home page says agents "ask, hand off and review", and its demo shows one agent passing a bug fix to another, who reviews it ([openbot.run](https://openbot.run/)). **The docs and the changelog describe no agent-reviews-agent feature.** In the demo, review is plain teamwork: one agent sends work to another with `send_message`, or assigns it as a channel task. The features that are named "review" in the docs are these:

- **Background memory review**: after 20 turns (10, 20, 40 or Off), a model without tools reads the recent conversation and returns `add`, `update` and `forget` operations on the agent's memories (`docs/architecture/providers.md`, "Background memory review"; openbot.run changelog 0.53.2).
- Section review before an agent's creation or edit is saved (README).
- Marketplace listings are reviewed; agent templates are not (`docs/glossary.md`).

OpenBot has nothing like a safety review: agents run with no per-action approval (README warning).

**Ours.** We have **Auto-review**, a separate model's check of each risky tool call (`CONTEXT.md`), which OpenBot lacks. We have no memory review, because our Bots edit their Memory files themselves. If "review" is part of the Team concept, it would be one Bot asking another to check its work: a handoff with a reply.

### 1e. Shared files and data

- **File transfers.** "Agent-to-agent messages, replies, reactions, images, and managed file transfers" (README). Agents attach files to an answer with `attach_files_to_response` (`docs/architecture/providers.md`), and files can be sent in joined-server threads (openbot.run changelog 0.53.0). Each agent has its own workspace (`~/OpenBot/Agents/<id>`), and there is a Shared folder (`docs/glossary.md`; openbot.run changelog 0.53.2).
- **Shared tables.** "A table an agent created in the one file every agent shares" (`~/OpenBot/Shared/Data/agent-data.db`). Only the owning agent can drop or alter a table, and every agent can read and write its rows (`docs/glossary.md`).
- **Shared browser profile.** The browser profile "Shared" is the default, and named profiles exist (`docs/glossary.md`).
- **No locking.** "OpenBot does not lock files"; the `start_task` guidance warns the agent (`docs/architecture/agents.md`, "Agent threads").

**Ours: partial.** All of a user's Bots share one **Computer**, with its files and browser sign-ins, and one **Knowledge** that they all read and edit (`CONTEXT.md`). So files are shared already, by place rather than by transfer. No Bot can send a file to another Bot, and we have no shared tables.

### 1f. Human teams

A server has members with a team role (owner, admin or member) and custom roles that set "which agents its members can use, and at which level" (`agent-access-v1`). Team members can message agents on the owner's computer, and those turns use the owner's provider sign-in (`docs/glossary.md`; `docs/provider-terms.md`).

**Ours: missing.** Bots belong to one user, and the only other role is **Admin**, who never reads Conversations (`CONTEXT.md`).

---

## 2. Task queue

- "FIFO message queues with pause, resume, cancellation, and crash-safe persistence" (README). Work sent while an agent is busy waits "in a queue that you can pause, resume or cancel" ([openbot.run](https://openbot.run/)).
- **Steer**: a queued message can be steered into the running turn when the provider supports it, natively for Claude, Codex, Grok, DeepSeek and Pi. Steer is hidden for Gemini, OpenCode, Cursor, Cline and custom agents, "because these providers cannot take a message into a running turn" (`CHANGELOG.md`). Each agent has a busy-message mode, "steer" or wait (`docs/architecture/agents.md`; Settings > Agents, "Steer agents while they work").
- **Edit**: the optional `queue-edit-v1` capability holds a queued message for editing (`docs/architecture/channels-and-messaging.md`, "Mobile chat queue").
- **Side threads**: an agent has a main thread and side threads (tasks), which run beside the main lane within a task limit. They have Stop, close (archive) and "Run in new thread" for a queued message (`docs/architecture/agents.md`, "Agent threads").

**Ours: partial.** The **Conversation queue** keeps Triggers in order and runs one Turn at a time. A Turn waits a moment so quick Messages land in one batch. A user's new Message interrupts the running Turn, and the next Turn takes the Message "with the first one's work in view". That interrupt plays the part of steer. **Stop** ends the Turn (`CONTEXT.md`). We have no pause or resume of a queue, no cancel or edit of one queued item, and no side threads. A Bot has exactly one Conversation by design.

---

## 3. Provider failover

- Each agent has backup models, set in agent settings ("Add backup model"). When a plan reaches its limit, or the provider is overloaded or down, the agent moves to a backup on another provider and "keeps its chat and workspace" ([openbot.run](https://openbot.run/)).
- When backups are set to Automatic, a provider error moves the agent to the next backup: "a spent balance, an unavailable provider, a rate limit, a sign-in error and a network error". The message runs again on the backup (`CHANGELOG.md`). The errors named include Claude's "529 Overloaded" and Codex's overload and retry-limit errors. The agent returns to its main model after 10 minutes (openbot.run changelog 0.48.2).
- A model-switch marker shows in the chat and in each affected channel (`docs/architecture/channels-and-messaging.md`). Completed work, tool results and attachments are kept with the request across backup models (`CHANGELOG.md`).

**Ours: missing.** A Bot has one selected Model (`CONTEXT.md`). The only "failover" in `packages/botsdk` is a Postgres pool comment (`packages/botsdk/bot/src/storage/client.ts`).

---

## 4. Providers: existing plans and ACP agents

- **Plans you already pay for**: Codex with a ChatGPT plan, Claude Code with a Claude plan, Gemini with Google AI Pro or Ultra (through Google's Antigravity ACP server), Grok, Cursor with a Cursor plan or API key, Cline with a Cline account, and OpenCode free and Go models (README, "Agent setup"). OpenBot "uses the existing local CLI login" and "does not copy provider credentials". It shows plan usage per provider (`docs/architecture/providers.md`).
- **How each runs.** Codex runs as the Codex App Server. Claude runs through the Claude Agent SDK, which starts the `claude` CLI (`docs/provider-terms.md`). Grok runs as its CLI. OpenCode, Gemini, Cursor and Cline run over **ACP** (`opencode acp`, `cursor-agent acp`, `cline --acp`). Pi, Muse, DeepSeek and OpenRouter are also listed (`docs/architecture/providers.md`; openbot.run changelog 0.51.0).
- **Custom agents.** "Custom OpenAI-compatible endpoints and custom ACP agents, with detection of local model servers (Ollama, LM Studio) and installed agents" (README). The `acp` provider runs ACP programs the user saves, such as Goose and Qwen Code (`docs/architecture/providers.md`, "Custom agents"; [openbot.run](https://openbot.run/)).
- **Terms.** OpenBot quotes Anthropic: "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications" (`docs/provider-terms.md`, read by them on 2026-10-06). Team members' turns use the owner's Claude sign-in.

**Ours: partial.** Providers are TanStack AI chat adapters: Anthropic, OpenAI, Gemini, Grok, OpenRouter, Ollama and others (`CONTEXT.md`; `packages/botsdk/bot/src/models/adapters.ts`). The only plan sign-in is a linked **ChatGPT plan** (ADR 0023; `packages/botsdk/bot/src/models/chatgpt-plan.ts`). We cannot run a coding-agent CLI or an ACP agent as a Bot's Model. The agent loop is ours, so this would mean a different kind of Turn. A Claude plan sign-in would also have to clear the Anthropic terms quoted above, since our Bots are a product built on Claude rather than ordinary use of Claude Code.

---

## 5. Built-in browser and computer use

- "A persistent embedded browser that agents can open, inspect, and control" (README). Browser profiles are named, persistent sessions, Shared by default (`docs/glossary.md`; openbot.run changelog 0.49.0). Each task thread has its own browser tabs and tab queue (`docs/architecture/agents.md`). A browser step that needs the user ("Complete the step") shows as a card (`CHANGELOG.md`).
- Optional Computer Use on macOS, Windows and Linux through the bundled `cua-driver`, given to every provider (README).

**Ours: partial.** The browser lives in a **Screen** on the cloud **Computer**. A Bot uses it only through a **Computer-use Helper**, at most four Screens per Computer, and its Chrome sign-ins stay on the Computer (`CONTEXT.md`). The Bot itself has no direct browser tools, and the user sees no live browser panel. We have **Demonstration** (the Bot watches the user do a task), which OpenBot lacks.

---

## 6. Mobile companion apps

- iPhone (on the App Store since 0.52.0) and Android apps connect to the user's computer or server: "talk to your agents from your phone" ([openbot.run](https://openbot.run/); openbot.run changelog 0.52.0). Pairing is by a Mobile Connect QR code (`openbot mobile-connect`, `docs/self-hosted-server.md`), over WebRTC through the Signal service, or on a private network such as Tailscale (openbot.run changelog 0.49.0).
- The apps have agent and channel chats, the queue, plan cards and `ask_ui` answers, iPhone Live Activity and push notifications while away, and Android notifications (`docs/architecture/channels-and-messaging.md`).

**Ours: missing.** The only app is `apps/web`. `CONTEXT.md` lists mobile among a Channel's apps, but none exists.

---

## 7. External messaging

Slack, Discord and Telegram connections: each workspace has an **Orchestrator** agent that receives new conversations, asks its teammates with `send_message`, and posts the answer in the same thread. Approvals and Stop are posted as buttons that only the starting user can press (`docs/architecture/channels-and-messaging.md`, "Messaging connections"; `docs/glossary.md`).

**Ours: partial.** **Email** is our one outside Channel (`packages/botsdk/channel-email`, spec #761), and inbound webhooks start Routines. The Orchestrator pattern is a Team shape too: one Bot that takes every request and delegates.

---

## 8. Plugins, skills and marketplace

- "A plugin is one developer's bundle: an MCP server, shown as an app, the skills that drive it, and the listing text." The catalog is a static file set served from `openbot.run` (`docs/architecture/skills-and-plugins.md`; `docs/plugin-distribution.md`). [openbot.run/plugins](https://openbot.run/plugins) lists 30, including Notion, Figma, Linear, Obsidian, Sentry, Vercel, Supabase, Stripe, Firecrawl and Composio. Users can also add MCP servers. A **connector** is a built-in sign-in such as GitHub (`docs/glossary.md`).
- A Marketplace offers agents, skills and plugins ([/guides/openbot-marketplace](https://openbot.run/guides/openbot-marketplace)). **Agent templates** are public, link-only copies of an agent's instructions, skills and routines (`docs/glossary.md`).
- **Local skills**: an agent creates a skill with `create_skill`, into a shared local library with versions. Other agents install it from there (README, "Local skills").

**Ours.** For plugins, **partial**: **Connections** are sign-ins to the MCP servers the Host offers, and their tools are Deferred tools checked by Auto-review (`CONTEXT.md`). We have no catalog, no user-added servers and no bundled skills. For skills, **have**: a **Skill** is a file in its Bot's directory, written by the Bot or the user or drafted from a Demonstration. Skills are per Bot, with no shared library or install.

---

## 9. Other features, briefly

| OpenBot                                                                                                                                                                                           | Ours                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Memory: per agent, channel and messaging connection, with `remember`, `search_memories` and `forget_memory`, up to 256, plus background review (`docs/architecture/providers.md`; `CHANGELOG.md`) | **Have**: Memory as files (Profile, Log and Notes), with every Profile shared across Bots. No background review |
| Routines: schedule or webhook, per agent or channel; quiet runs (`routine_no_update`); failure reports; an iCalendar feed (`docs/architecture/agents.md`)                                         | **Have**: Routine and Check-in. No calendar feed or channel Routines                                            |
| Context compaction per agent (README)                                                                                                                                                             | **Have**: Summary                                                                                               |
| Vault for API keys (openbot.run changelog 0.50.0, 0.52.1)                                                                                                                                         | **Have**: Secret                                                                                                |
| Headless Linux server, Docker, hosted servers sold by plan ([self-hosted servers](https://github.com/nightly-labs/openbot/blob/main/docs/self-hosted-server.md))                                  | **Have**, differently: the Bot SDK is embedded by a Host                                                        |
| Import agents from Grok Bot and Hermes (README; /guides)                                                                                                                                          | Missing, and not relevant                                                                                       |
| No per-action approval; full access (README)                                                                                                                                                      | We have Approval and Auto-review                                                                                |

---

## For the Team ticket

From the sources, these are OpenBot's parts of a team:

1. **Direct messages between agents**: a `send_message` tool, replies that can steer the receiver's running turn, and a rule against acknowledgement loops.
2. **A shared room** (their "channel"): members, a **lead** that routes each request to **one owner** (rules first, the model only when needed), tasks with owners and child tasks, transfer and reassign, Stop and Resume per task, bounded context with a summary, and limits on automatic fan-out (8 per request, 2 active).
3. **Shared files and data**: transfers attached to messages, a Shared folder, and shared tables.
4. **Static pipelines**: routine flows and Workflows, where one agent's answer is passed on to the next.

Review in OpenBot is not a mechanism of its own. It is a handoff with a reply.

Our existing pieces map like this. Helpers are one-way, Bot-owned delegation. The shared Computer and Knowledge already give shared files. Triggers have no `bot` source yet. "Channel" is taken by our glossary, so the Team ticket needs another word for the shared room.
