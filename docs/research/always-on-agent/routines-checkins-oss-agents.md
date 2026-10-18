# How open-source always-on agents do Routines and Check-ins

Research for [#535](https://github.com/Daanish2003/ai-chat/issues/535) (child of map [#415](https://github.com/Daanish2003/ai-chat/issues/415)). Researched 2026-10-18. This file holds facts and links only and makes no design decisions for this repo.

It goes deeper than [#389](https://github.com/Daanish2003/ai-chat/issues/389) ([findings](https://github.com/Daanish2003/ai-chat/blob/research/open-source-always-on-agents/docs/research/always-on-agent/open-source-always-on-agents.md)), which covered these features in one paragraph each. Things #389 already says are not repeated unless a detail changed.

## Sources

Each repo is pinned to the commit read on 2026-10-18:

| Short | Repo                                                                      | Commit                                     |
| ----- | ------------------------------------------------------------------------- | ------------------------------------------ |
| OC    | [openclaw/openclaw](https://github.com/openclaw/openclaw)                 | `1507c89eaa51d713a97b4135d72afb976856a485` |
| HA    | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `9e01b44dd23978f9ff40b7837467f3a9f1582130` |
| LC    | [letta-ai/letta-code](https://github.com/letta-ai/letta-code)             | `7be3c81f9cfce481994fe4484d59a5bf17cdb48a` |

Plus the docs page [docs.letta.com/letta-code/scheduling](https://docs.letta.com/letta-code/scheduling), which is not versioned.

Link bases:

- OC: `https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/`
- HA: `https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/`
- LC: `https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/`

The lecture's target shape (from the slide write-up on [#383](https://github.com/Daanish2003/ai-chat/issues/383)):

- `routines/<name>` is a prompt plus a schedule, such as weekdays 8:00 (slide 11).
- A Routine can be a schedule or a webhook, and the agent can create one from chat ("Created Sales Outbound routine").
- A Routine run is a Trigger that runs a turn, and it joins the back of the queue (slide 20).
- The flow is Router → per-conversation queue → "Anything worth saying?": yes means send, no means stay quiet (slide 14).
- Every wake-up records where it came from.
- "New routines need your OK" (slide 29).
- A "scheduled check-in" is a separate wake source.

---

## 1. OpenClaw: Automations, plus the heartbeat monitor

### Storage and format

- **Store.** "Job definitions, runtime state, and run history persist in OpenClaw's shared SQLite state database" ([OC docs/automation/cron-jobs/how-it-works.md](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/docs/automation/cron-jobs/how-it-works.md)).
- **Five schedule kinds:**
  - `at`: ISO 8601, or relative such as `20m`.
  - `every`: `10m`, `1h`, `1d`.
  - `cron`: 5 or 6 fields, with optional `--tz` (IANA). It is parsed by croner, and day-of-month and day-of-week combine with OR.
  - `on-exit`: fires when a watched command exits.
  - `stream`: fires on lines from a supervised command.
- **Timezones and stagger.** A cron without `--tz` uses the Gateway host timezone. Top-of-hour crons are staggered by up to 5 minutes unless `--exact` is set.
- **No natural-language form** such as "weekdays 8:00". The agent restates the schedule in words when it confirms (below).
- **Event triggers.** A condition script can gate an `every`, `cron` or `stream` job. It returns `{ fire, message?, state? }` with state capped at 16 KB. The minimum interval is 30 s, and each evaluation gets a 30 s budget and 5 tool calls ([OC docs/automation/cron-jobs/schedules.md](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/docs/automation/cron-jobs/schedules.md)).
- **Webhooks.** `POST /hooks/wake`, `POST /hooks/agent` and mapped `POST /hooks/<name>` routes, plus Gmail PubSub ([OC docs/automation/cron-jobs.md](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/docs/automation/cron-jobs.md)).

### What fires it, and missed runs

- **In-process.** Jobs "run inside the Gateway process, not inside the model. The Gateway must be running for schedules to fire" (how-it-works.md).
- **At startup,** overdue agent-turn jobs "are rescheduled instead of replayed immediately". Slots that passed during a run that finished are not replayed. Slots missed after that run finishes stay eligible for catch-up. Missed timer ticks are coalesced from stored deadlines.
- **Crash recovery.** Recovery matches a recorded terminal result to the exact run identity and does not run the payload again. Without a recorded terminal result, the run becomes interrupted with delivery **Unknown**, and it is not retried. The reason given is "This avoids replaying uncertain command, script, tool, or delivery effects after a crash, at the cost of possibly missing an occurrence".

### Which conversation the run lands in, and what the model is told

- **Four execution styles** ([OC docs/automation/cron-jobs/payloads.md](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/docs/automation/cron-jobs/payloads.md)):
  - `main` enqueues a system event into the agent's main session.
  - `isolated` runs in a fresh `cron:<jobId>` session each time.
  - `current` runs detached, reads a bounded tail of the conversation captured at creation, and delivers to that conversation.
  - `session:<id>` runs in a persistent named session.
- **Default.** "Agent-turn jobs default to the creating conversation when the create request carries session context." Callers without a session key fall back to `isolated`.
- **Delivery.** By default the result goes back to the creating chat. An isolated run "still does not read that conversation's history".
- **Wake text in code:**
  - The isolated prompt is prefixed `[cron:<jobId> <jobName>]` and followed by a time line ([OC src/cron/isolated-agent/run-prepare.ts](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/src/cron/isolated-agent/run-prepare.ts), around line 502).
  - A static preamble is then appended. The code comment says "Keep the suffix static for prompt caching". The preamble reads: "This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply with exactly NO_REPLY as the entire final answer. …" ([OC src/cron/isolated-agent/run-prepare-runtime.ts](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/src/cron/isolated-agent/run-prepare-runtime.ts), `appendCronUnattendedRunPreamble`).
  - Trusted (non-webhook) jobs also get: "Where the job's own instructions conflict with this preamble, the job's instructions win … If this job is no longer needed, remove it if your available tools allow."
  - Webhook content is wrapped by `buildSafeExternalPrompt` and scanned for suspicious patterns.
- **Heartbeat transcripts** carry markers such as `[OpenClaw heartbeat poll]`, which separate a poll from an exec completion, a cron wake or a session event ([OC docs/gateway/heartbeat.md](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/docs/gateway/heartbeat.md)).

### Staying quiet

- **Isolated and hook runs** reply with an exact `NO_REPLY` (the preamble above).
- **A heartbeat** can also call `heartbeat_respond` with `notify: false`, or `notify: true` plus `notificationText`. A strict prefix of `NO_REPLY` (`NO_R` or longer) also counts as quiet on heartbeats only (heartbeat.md).
- **A condition script** returning `fire: false` skips the model call entirely and writes no run history (schedules.md).

### Can the agent create, edit or delete one, and what approval is needed

- **The tool.** The `automations` agent tool, with legacy alias `cron`, supports list, get, create, update, run, remove and `next_check`.
- **Who may manage jobs from chat.** "An authenticated channel sender explicitly listed in `commands.ownerAllowFrom`, or a Control UI administrator" can ask the agent to list, inspect, update, run or remove any automation. "Fresh authenticated Control UI administrator turns can also create ordinary automations through chat."
- **Grants.** Each operation uses "a one-use grant that expires after 60 seconds and remains bound to that exact active run". Other channel turns get no management grant ([OC docs/automation/cron-jobs/managing-jobs.md](https://github.com/openclaw/openclaw/blob/1507c89eaa51d713a97b4135d72afb976856a485/docs/automation/cron-jobs/managing-jobs.md)).
- **Promoting a repeated request into a schedule** (how-it-works.md):
  - When asked for the same job several times, the agent offers a schedule. It checks `automations(action: "list")` first to avoid duplicates.
  - "The confirmation restates the schedule and the task in plain words before anything is created, for example: 'Every weekday at 07:00 Europe/Vienna, I summarize overnight updates and post them here.' Confirm that sentence, not a cron expression."
  - On confirmation the agent creates the job, runs it once immediately with `run` in force mode as a visible test, and removes it if the test fails.
  - "The job is created **enabled**, not disabled-pending-approval, and that is a deliberate safety choice … A job left disabled waiting for a confirmation that never arrives is invisible to every guard."
  - The confirmation is conversational, driven by prompting gated on the tool. It is not a stored approval state.
- **Scheduled runs and their own job.** With "the narrow automation self-cleanup grant", isolated runs can read a self-filtered list and may remove only their own job.
- **`/loop`.** `/loop [interval] <prompt>` is owner-only and creates a recurring job bound to the conversation.

### Self-set wake-ups versus user-approved schedules

- **The heartbeat is a system-owned automation job,** one per agent (`Heartbeat (agent-id)`), with a default cadence of 30 m. It runs in the main session.
- **Heartbeat prompt.** "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY."
- **Monitor scratch.** Its checklist is "monitor scratch" in the database (256 KiB cap). The agent can fully replace it during a heartbeat via `heartbeat_respond`'s `scratch` field, with no approval.
- **Scratch is not a scheduler.** "Monitor scratch is prompt context, not a scheduler." The docs say "Human check-in: create a scheduled job if you want an occasional lightweight 'anything you need?' message" (heartbeat.md).
- **Guards on heartbeats.** They defer while the queue or target session is busy. Active hours apply. Event wakes are limited to at least 30 s apart and at most 5 per minute.
- **Self-pacing.** A paced job can call `automations(action: "next_check", in: "30m")`. The proposal applies only to the running job and is clamped to the job's `pacing.min`/`pacing.max` bounds (schedules.md).
- **"Come back later."** The documented way is a one-shot `at` job with `sessionTarget: "session:<your session key>"`, which "runs inside the existing conversation with the same history" (payloads.md).

---

## 2. Hermes Agent: `hermes cron`, plus `/heartbeat`

### Storage and format

- **Store.** Jobs live in `~/.hermes/cron/jobs.json`, a plain JSON file with atomic writes. Run output goes to `~/.hermes/cron/output/{job_id}/{timestamp}.md` ([HA website/docs/user-guide/features/cron.md](https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/website/docs/user-guide/features/cron.md), "Job storage").
- **Schedule strings** (cron.md, "Schedule formats"):
  - relative one-shots: `in 30m`
  - intervals: `every 2h`, or bare `30m`
  - **natural day and time:** `weekdays at 9am`, `every monday 9am`, `daily at 7am`, which "compile to cron expressions internally"
  - cron expressions, with named weekdays accepted
  - ISO timestamps
- **Defaults.** One-shots repeat once. Intervals and crons repeat forever, and `repeat=N` overrides that.
- **Webhooks.** A webhook route with `cron_job` set fires the job on an event (cron.md, "What cron can do now").
- **Bot Mode "Routines".** These are cron jobs named `[bot:<name>] <routine>`, edited in a desktop pane with a structured schedule picker. "Runs land in the Bot's own chat history" ([HA website/docs/user-guide/bot-mode.md](https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/website/docs/user-guide/bot-mode.md), "Routines").

### What fires it, and missed runs

- **The ticker.** "The gateway ticks the scheduler every 60 seconds, running any due jobs in isolated agent sessions." A file lock (`.tick.lock`) prevents overlapping ticks (cron.md, "How it works").
- **Missed slots.** A recurring job "**catches up once**". A slot missed in a restart gap fires once, a slot that already ran never runs again, and a long outage collapses into one run. Paused jobs never catch up.
- **Opting out.** `cron.catch_up_missed: false` re-anchors late jobs to their next occurrence instead (cron.md, "Local missed-run policy").
- **Crash recovery.** A job mid-run during a restart is marked `unknown` and not retried. A known terminal result is handed to delivery without running the agent again (cron.md, "Admission recovery").

### Which conversation the run lands in, and what the model is told

- **Fresh session.** Every fire starts a fresh `AIAgent` session ("a fresh isolated session per tick"). Prompts must be self-contained.
- **Delivery.** The final response goes to the `deliver:` target: origin chat (the default), `local`, `all`, `bot-chat`, or `platform:chat_id[:thread_id]`.
- **Continuity.**
  - `continuity: true` injects the job's own last non-silent output.
  - `context_from` injects another job's output ([HA cron/scheduler_prompt.py](https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/cron/scheduler_prompt.py)).
- **Wrapper.** By default the delivered output is wrapped as `Cronjob Response: <name>` with the footer "Note: The agent cannot see this message, and therefore cannot respond to it."
- **Continuable jobs.** These are opt-in (`attach_to_session` or `cron.mirror_delivery`). They seed the brief into a thread or DM session as a labelled user turn, `[Cron delivery: <task name>]`, so replies continue with context (cron.md, "Continuable jobs").
- **Prepended hint (`_CRON_HINT`).** Every cron prompt starts with: "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered to the user — do NOT use send_message … SILENT: If there is genuinely nothing new to report, respond with exactly "[SILENT]" (nothing else) to suppress delivery … RECURSION: This is a run of an EXISTING scheduled job — execute the task now. NEVER create or update a cron job because of recurring or future-schedule language in the task prompt below …]" (scheduler_prompt.py, line 260).

### Staying quiet

- **Cron runs.** A `[SILENT]` final response suppresses delivery, and the output is still saved locally. "Failed jobs always deliver regardless of the `[SILENT]` marker". `[CRON_FAILURE]` on the first line declares a failed run (cron.md, "Silent suppression").
- **Cheap gates that skip the model:**
  - A pre-run script whose last line is `{"wakeAgent": false}` skips the agent.
  - A change detector skips the run when its output is unchanged.
  - `no_agent` mode delivers script stdout with no LLM call, and empty stdout sends nothing.
- **Heartbeats.** A heartbeat turn may end with bare `NO_REPLY` or `[SILENT]`, and the gateway sends nothing ([HA website/docs/user-guide/features/heartbeat.md](https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/website/docs/user-guide/features/heartbeat.md)).

### Can the agent create, edit or delete one, and what approval is needed

- **One tool.** `cronjob_manage` has actions create, list, update, pause, resume, remove and run. "You can create, pause, edit, and remove jobs by asking in plain language."
- **No confirmation step.** The tool description has none ([HA tools/cronjob_tools.py](https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/tools/cronjob_tools.py), `CRONJOB_SCHEMA`, line 1056).
- **`paused=true`** can create a job disabled "as a safe canary". The docs give it its own section, "Creating a job paused (safe canary)".
- **User-owned fields.** Model pins and reasoning effort are user-owned: "The agent cannot point a job at a _different_ model" (cron.md, tips).
- **Inside cron runs.** "Cron-run sessions cannot recursively create more cron jobs" by default. `cron.allow_agent_scheduling: true` opts in, and a job may remove itself and still report (cron.md, "Agent-managed scheduling").
- **Prompt scanning.** Prompts are scanned for injection and exfiltration at create and update time (cron.md, "Security").

### Self-set wake-ups versus user-approved schedules

- **`/heartbeat every <interval> <prompt>`** is a slash command, so the user sets it. One heartbeat per session, minimum 60 s.
- **How it differs from cron:**
  - It runs "in this conversation", while cron runs in a fresh session.
  - It is idle-only, and missed ticks coalesce into one.
  - It is injected as a plain user-role message, so it is cache-safe.
  - Its state lives in `SessionDB.state_meta` under `heartbeat:<session_id>`.
- **Heartbeat prompt** ([HA hermes_cli/heartbeat.py](https://github.com/NousResearch/hermes-agent/blob/9e01b44dd23978f9ff40b7837467f3a9f1582130/hermes_cli/heartbeat.py), `HEARTBEAT_PROMPT_TEMPLATE`): "[Heartbeat — recurring instruction, fires every {interval}]\n{prompt}\n\nIf there is nothing meaningful to do or report for this instruction right now, reply briefly that nothing has changed and stop — do not invent work."
- **No agent-facing heartbeat tool.** I found none in `tools/`, so the agent's self-set follow-up is a `cronjob_manage` one-shot (`in 30m`).

---

## 3. Letta Code: schedules (`letta cron`) and the Wake tool

### Storage and format

- **Local store.** Local schedules live in `~/.letta/crons.json`. It uses atomic writes, a mkdir lock and a scheduler-owner lease (PID plus token), and garbage-collects terminal tasks after 24 h ([LC src/cron/cron-file.ts](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/cron/cron-file.ts)).
- **Task fields.** A `CronTask` stores:
  - a numeric 5-field `cron` string with an IANA `timezone`, `recurring`, and `scheduled_for` for one-shots
  - `prompt`, `name`, `description` and `conversation_id`
  - a status: `active`, `paused`, `fired`, `missed` or `cancelled`
  - outcome counters
- **Cloud store.** Cloud schedules live in Letta Cloud and use UTC.
- **CLI.** `--every 5m`, `--at "in 45m"` or an RFC 3339 time, or `--cron "0 9 * * 1-5"`. There is no named-day or natural-language form. "In-place editing is not available. To change a schedule, create and verify the replacement before deleting the old one" ([LC src/skills/builtin/scheduling-tasks/SKILL.md](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/skills/builtin/scheduling-tasks/SKILL.md)).
- **No webhook-triggered schedule found.** The closest are `Monitor` and `WatchPR`, which are event tools.

### What fires it, and missed runs

- **Local.** An in-process `setInterval` ticks every 60 s. On each tick it checks whether a task's cron "matches this minute" and enqueues it into the conversation runtime's queue ([LC src/cron/scheduler.ts](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/cron/scheduler.ts), header and `shouldFireTask`).
- **No catch-up for recurring tasks.** A minute that passes while no process runs is simply not matched.
- **One-shots.** A one-shot more than 5 minutes overdue is marked `missed` with reason `scheduler_inactive` (`handleMissedOneShot`). Docs: local schedules fire "only while a CLI or server process is open", and "fires while no session runs are marked as missed".
- **Cloud.** Cloud schedules "fire from a server-side timer". A `--computer` target that is offline "falls back to the Cloud sandbox" ([docs.letta.com/letta-code/scheduling](https://docs.letta.com/letta-code/scheduling)).

### Which conversation the run lands in, and what the model is told

- **CLI default: a fresh conversation.** An omitted `--conversation` means "new", so every fire gets a fresh conversation tagged `origin:schedule`. `self`, `default` and a concrete id are the alternatives (SKILL.md; `resolveCronFireConversationId` in scheduler.ts).
- **Stored-file default.** The `CronTask.conversation_id` doc comment says `"default"` is the default for stored tasks. The CLI writes `new` when the flag is omitted.
- **The Wake tool** is always bound to the current conversation.
- **Envelope text** ([LC src/cron/scheduled-task-prompt.ts](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/cron/scheduled-task-prompt.ts), `formatScheduledTaskPrompt`):
  - `Scheduled task "<name>" is firing.`
  - Description, Timezone, `Scheduled for:` and `Current time:` (timezone-qualified ISO)
  - `This is fire #N (cron: …).`
  - "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked."
  - `Prompt: <prompt>`
  - The module also parses this envelope back out of stored messages.

### Staying quiet

- **No silence token for scheduled runs.** The envelope tells the agent to deliver "through your available channels". #389 found that a normal assistant response is not delivered to an external channel unless the `MessageChannel` tool is called, so a quiet run is one that sends nothing.
- **Cloud.** I did not find a silence rule for Cloud runs specifically.

### Can the agent create, edit or delete one, and what approval is needed

- **Self-scheduling is supported.** "Your agent can also schedule tasks itself. Simply ask it in chat" (docs page). There are two routes.
- **The `Wake` tool** ([LC src/tools/descriptions/Wake.md](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/tools/descriptions/Wake.md), [schema](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/tools/schemas/Wake.json)):
  - It schedules "a future turn for the current conversation".
  - Actions are create, list and cancel, with exactly one of `after_seconds` (60 s to 1 year), `scheduled_at` or `cron` (UTC, "cannot run more often than hourly").
  - It is "always self-bound. It cannot target another agent, conversation, or computer."
- **The `letta cron` CLI,** run through the Bash tool and documented in the built-in `scheduling-tasks` skill, covers other conversations, computers, run history and replacement.
- **Approval:**
  - `Wake` is on the auto-allow list, with the comment "These only touch agent-owned state: … prompts scheduled back to this agent" ([LC src/permissions/checker.ts](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/permissions/checker.ts), around line 790). It never asks.
  - `letta cron` goes through the ordinary Bash permission path. I found no special rule for it in `checker.ts`.
  - The docs page mentions no approval step.
- **What the skill tells the agent** is to state the timezone conversion "in your reply so the user can catch a wrong assumption". That is a confirmation after the fact, not a gate.

### Self-set wake-ups versus user-approved schedules

- **Wake** is the self-set "check back later". The description says "Wake is the durable, time-based counterpart to Monitor: use Monitor when ongoing work can emit an event, and Wake when you need to act at a future time".
- **Same store, two scopes.** Wakes and user schedules are the same kind of task in the same store. The differences are scope (current conversation only), the hourly floor on recurring wakes, and the auto-allow permission.
- **Sleep-time.** In Letta Code, sleep-time is memory reflection, not a timer. Its `SleeptimeSelector` offers the triggers `off`, `step-count` and `compaction-event` ([LC src/cli/components/SleeptimeSelector.tsx](https://github.com/letta-ai/letta-code/blob/7be3c81f9cfce481994fe4484d59a5bf17cdb48a/src/cli/components/SleeptimeSelector.tsx)).
- **Heartbeats.** As in #389, I found no agent heartbeat that fires on a timer.

---

## 4. Other projects

#389 already covered OpenBOT's in-app Routines (recorded tool sequences, a 30 s ticker, a `Scheduled: <name>` session) and found that Open GrokBot has no scheduler. I found nothing new worth adding for this question.

---

## 5. Side by side

| Question                 | OpenClaw                                                                                                  | Hermes                                                                      | Letta Code                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Store                    | SQLite (shared state DB)                                                                                  | `~/.hermes/cron/jobs.json`                                                  | `~/.letta/crons.json` (local), Letta Cloud                                     |
| Formats                  | `at`, `every`, cron (+tz), on-exit, stream, condition script                                              | `in 30m`, `every 2h`, **`weekdays at 9am`**, cron, ISO                      | `--every`, `--at`, numeric cron (UTC in Cloud)                                 |
| Webhook                  | `/hooks/agent`, mapped hooks, Gmail                                                                       | webhook route with `cron_job`                                               | not found                                                                      |
| Fires from               | Gateway process scheduler                                                                                 | gateway 60 s tick                                                           | listener 60 s tick, or Cloud timer                                             |
| Missed while down        | rescheduled, not replayed; crash = interrupted, not rerun                                                 | catch up **once** (opt-out); crash = `unknown`, not rerun                   | recurring: skipped; one-shot >5 min late = `missed`                            |
| Lands in                 | creating conversation by default (`current`); or `main`, `isolated`, `session:<id>`                       | fresh session; result delivered to origin chat (one-way unless continuable) | fresh conversation by default (`origin:schedule`); or `self`, `default`, id    |
| Told why it woke         | `[cron:<id> <name>]` + time + static "unattended scheduled run" preamble                                  | `[IMPORTANT: You are running as a scheduled cron job …]`                    | `Scheduled task "<name>" is firing.` + times + fire # + "running autonomously" |
| Quiet                    | exact `NO_REPLY`; `heartbeat_respond notify:false`; script `fire:false` skips the model                   | `[SILENT]` (failures still deliver); `wakeAgent:false`; `no_agent`          | send nothing (no auto-delivery); no token                                      |
| Agent creates            | yes, `automations` tool, owner or admin turns only                                                        | yes, `cronjob_manage`                                                       | yes, `Wake` tool or `letta cron` via Bash                                      |
| Approval                 | plain-words confirmation, then a forced test run; created **enabled**                                     | none in the tool; optional `paused` canary                                  | `Wake` auto-allowed; Bash goes through normal permission                       |
| Cron run makes more jobs | only removes itself (self-cleanup grant)                                                                  | off by default (`allow_agent_scheduling`)                                   | not restricted in what I read                                                  |
| Self-set wake            | heartbeat (system job, main session, 30 m) + scratch; `next_check` pacing; one-shot `at` into own session | `/heartbeat` (user command, same session, idle-only)                        | `Wake` (current conversation, hourly floor for recurring)                      |

## 6. Against the lecture's shape

**Where they agree:**

- **A Routine is a stored prompt plus a schedule** in all three. Hermes's `weekdays at 9am` is closest to the lecture's `weekdays 8:00`. OpenClaw and Letta store cron strings, and OpenClaw restates them in plain words when confirming.
- **Webhooks as a Routine source** exist in OpenClaw (`/hooks/*`) and Hermes (`cron_job` webhook routes). OpenClaw labels webhook text as external and wraps it in a safety prompt.
- **The agent creates Routines from chat** in all three.
- **Runs go through the conversation's queue.** OpenClaw and Letta enqueue into the session's queue runtime. Hermes heartbeats wait for the input queue to drain, so "user messages win".
- **"Anything worth saying?" maps to a silence path:** `NO_REPLY` (OpenClaw), `[SILENT]` (Hermes), or not sending (Letta). OpenClaw and Hermes can also skip the model entirely with a cheap pre-check.
- **Provenance.** Every wake carries a recorded source in the prompt: `[cron:…]`, `[IMPORTANT: … scheduled cron job]`, `Scheduled task "…" is firing.`, `[OpenClaw heartbeat poll]` or `[Heartbeat — …]`.
- **A Check-in is distinct from a Routine** in all three: OpenClaw's heartbeat, Hermes's `/heartbeat`, Letta's `Wake`.

**Where they differ:**

- **"New routines need your OK."**
  - Only OpenClaw documents a confirmation before creating, and it is conversational. It is a plain-words sentence plus a forced test run, and the job is then created enabled. OpenClaw argues explicitly against a disabled-pending-approval state.
  - Hermes has no confirmation in its tool. It offers a `paused` canary.
  - Letta auto-allows `Wake`.
  - None stores an approval record.
- **Which conversation.** The lecture's "picks the conversation" is answered differently: OpenClaw defaults to the creating conversation, while Hermes and Letta default to a fresh session or conversation per run.
- **Missed runs** are handled three ways: rescheduled without replay (OpenClaw), caught up once (Hermes), or skipped (Letta local). The lecture does not say.
- **Self-set Check-ins have no approval gate anywhere.** OpenClaw lets the heartbeat rewrite its own scratch, and Letta auto-allows `Wake`. The lecture's OK rule is about Routines, and these projects apply no gate to self-set wakes.

## Unverified or not found

- Letta Code: I found no webhook trigger for schedules, no silence token, and no Bash permission rule specific to `letta cron`.
- Hermes: I found no agent-facing tool for setting a heartbeat (it is a slash command). I did not read the gateway webhook route code, only the docs.
- OpenClaw: I read the promotion confirmation flow in the docs only. I found no code that enforces a confirmation before `automations create`. The docs say it is prompting gated on the tool.
