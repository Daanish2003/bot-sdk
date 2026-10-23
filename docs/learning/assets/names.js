// Every code name the lessons teach, in one list. Lessons load this file with
// <script src="../assets/names.js" data-upto="N"></script> to get the floating "Names?" button,
// which lists the names from Lessons 9..N (Lessons 1-8 taught the assistant and are archived). reference/names.html renders the full list.
//
// kind: package · file · function · type · table/column · route
window.NAMES = [
  {
    lesson: 9,
    name: "packages/bot-sdk",
    kind: "package",
    meaning:
      "The Bot SDK: one folder a Host copies in: a core (core/shared, core/server, core/client), plugins (models, runner, bot, computer, memory, knowledge, skills, channel, mcp), ui/ and extras/.",
    example: "pnpm -F @ai-chat/bot-sdk copy ../my-host/src/lib/bot-sdk",
  },
  {
    lesson: 9,
    name: "core/shared",
    kind: "folder",
    meaning:
      "Code both sides use: base Message parts, Attachments, error codes. Imports only npm packages.",
    example: "core/shared/message-parts.ts",
  },
  {
    lesson: 9,
    name: "core/server",
    kind: "folder",
    meaning:
      "The core's server code: createBotSdk, the handler, the core routers and tables. Plugins sit in plugins/*/server. Imports only shared.",
    example: "core/server/create-chat.ts",
  },
  {
    lesson: 9,
    name: "core/client",
    kind: "folder",
    meaning:
      "The browser side: createBotSdkClient, plus ChatProvider and hooks in client/react. Reaches server only with import type.",
    example: "core/client/chat-client.ts",
  },
  {
    lesson: 9,
    name: "ui/",
    kind: "folder",
    meaning:
      "The SDK's React components (ui/ and each plugin's ui/). The Host owns them; the copy script copies them only once.",
    example: "BotsApp from @ai-chat/bot-sdk/plugins/bot/ui in components/bots-shell.tsx",
  },
  {
    lesson: 9,
    name: "@ai-chat/bot-sdk/core/server · /core/client · /plugins/*",
    kind: "package",
    meaning:
      "The entry points in the SDK's package.json (core/server, core/client, and server, client and ui for each plugin); a Host imports nothing else.",
    example:
      'import { createBotSdk } from "@ai-chat/bot-sdk/core/server" in apps/web/src/services.ts',
  },
  {
    lesson: 9,
    name: "createBotSdk",
    kind: "function",
    meaning:
      "Builds the Bot SDK for a Host from its options; returns the handler, migrate/start/stop and server-only calls. Builds nothing until first use.",
    example:
      'export const sdk = createBotSdk({ databaseUrl, getUser, keyEncryptionSecrets, basePath: "/api/chat", plugins }) in apps/web/src/services.ts',
  },
  {
    lesson: 9,
    name: "migrate / start / stop",
    kind: "function",
    meaning:
      "The lifecycle: migrate() at deploy, start() at boot (checks the setup, starts the plugins), stop() on SIGTERM.",
    example: "apps/web/server/plugins/chat-lifecycle.ts calls sdk.start() and sdk.stop()",
  },
  {
    lesson: 9,
    name: "core",
    kind: "folder",
    meaning:
      "The base every Bot SDK has: infrastructure, Conversation, Message, the message tree, base parts and attachments.",
    example: "core/server/db/core-schema.ts",
  },
  {
    lesson: 9,
    name: "plugins/<name>/",
    kind: "folder",
    meaning:
      "One plugin's folder, in shared, server, client and ui. The Bot SDK has nine: models, runner, bot, computer, memory, knowledge, skills, channel and mcp.",
    example: "plugins/bot/server/plugin.ts",
  },
  {
    lesson: 9,
    name: "BotSdkPlugin",
    kind: "type",
    meaning:
      "A plugin's plain object: id, requires, router, routes, rateLimits, init, start, stop, databaseHooks, deleteUser, exportUser and rotateKeys.",
    example: 'bot() returns one with id "bot" and requires ["models", "runner"]',
  },
  {
    lesson: 9,
    name: "plugin(id)",
    kind: "function",
    meaning:
      "Returns an enabled plugin's API from the context, typed through PluginApis. It throws when the plugin is not enabled.",
    example: 'sdk.plugin("models").quota(userId)',
  },
  {
    lesson: 9,
    name: "PluginApis",
    kind: "type",
    meaning:
      "The interface each plugin extends by declaration merging, so plugin(id) knows the type of its API.",
    example: "interface PluginApis { models: ModelsApi }",
  },
  {
    lesson: 9,
    name: "orderPlugins",
    kind: "function",
    meaning:
      "Sorts the plugins so that each comes after the plugins it requires. Throws on a missing requirement, a duplicate id or a cycle.",
    example: "orderPlugins([bot, models]) → models, bot",
  },
  {
    lesson: 9,
    name: "fields",
    kind: "table/column",
    meaning:
      "A plugin's part of a core table: Drizzle column builders and an index callback, composed into conversation or message.",
    example:
      "A plugin that adds a column to conversation: fields.conversation.columns.<name> in its schema.ts",
  },
  {
    lesson: 9,
    name: "deleteConversations",
    kind: "function",
    meaning:
      "The one core function that deletes Conversations. It runs each plugin's before hook in the transaction and each after hook after the commit.",
    example: "core/server/chat/delete-conversations.ts",
  },
  {
    lesson: 10,
    name: "runTurn",
    kind: "function",
    meaning:
      "The Bot's Turn loop: chat() with send_to_user as its only tool. It streams each sent Message, then ends the Turn row with its transcript and usage.",
    example: "plugins/bot/server/turn.ts",
  },
  {
    lesson: 10,
    name: "send_to_user",
    kind: "function",
    meaning:
      "SendToUser, the Bot's only tool in step 1. Takes { text, endTurn }; each call appends one Message. Empty text returns emptyTextError.",
    example: 'send_to_user({ text: "On it…", endTurn: false })',
  },
  {
    lesson: 10,
    name: "endTurn",
    kind: "type",
    meaning:
      "The boolean on every send_to_user call. true on the last message ends the Turn with no further Model call.",
    example: 'send_to_user({ text: "Done.", endTurn: true })',
  },
  {
    lesson: 10,
    name: "botSystemPrompt",
    kind: "function",
    meaning:
      "The fixed Bot system prompt: the user sees only send_to_user messages, and a reply with no tool call is quiet.",
    example: "plugins/bot/server/turn.ts",
  },
  {
    lesson: 10,
    name: "turnStepLimit · turnTimeLimitMs",
    kind: "function",
    meaning:
      "A Turn's limits: 10 Steps and 5 minutes. Past either, the Turn ends error with step_limit or timed_out.",
    example: "turnStepLimit = 10",
  },
  {
    lesson: 10,
    name: "bot_turn",
    kind: "table/column",
    meaning:
      "One row per Turn: status (running, complete, error, stopped), error, usage, and the private transcript, written once when the Turn ends.",
    example: "bot_turn.transcript",
  },
  {
    lesson: 10,
    name: "BotSendEvent",
    kind: "type",
    meaning:
      "What bot.send streams: { type: 'message', message } for each Message, then { type: 'turnEnded', status }.",
    example: "plugins/bot/shared/turn.ts",
  },
  {
    lesson: 11,
    name: "ctx.activity",
    kind: "function",
    meaning:
      "Runs fn once and saves its JSON result as a Checkpoint. A replay returns the saved result without running fn. With a (tx) parameter, fn writes in the transaction its Checkpoint is saved in.",
    example: "ctx.activity('send_to_user', async (tx) => …)",
  },
  {
    lesson: 11,
    name: "chat.job_event",
    kind: "table/column",
    meaning:
      "A job's history: one row per Checkpoint, keyed (job_id, seq), with kind, name and a JSON result. It goes when its job is pruned.",
    example: "job_event.seq",
  },
  {
    lesson: 11,
    name: "createWorkflow",
    kind: "function",
    meaning:
      "The workflow engine: replays a history, then records each new call through a fenced store. It imports nothing from the Bot SDK.",
    example: "plugins/runner/server/workflow/engine.ts",
  },
  {
    lesson: 11,
    name: "NonDeterminismError",
    kind: "type",
    meaning:
      "Thrown when a replayed call does not match the history entry at its seq. It fails the job for good and runs onFailed.",
    example: "Non-deterministic workflow at seq 2",
  },
  {
    lesson: 11,
    name: "ctx.now · ctx.random · ctx.patched",
    kind: "function",
    meaning:
      "Recorded calls. now and random replay their first values; patched(id) is true in a new run or a replay with the marker, false in an older replay.",
    example: "await ctx.patched('v2')",
  },
  {
    lesson: 11,
    name: "ownAttempt",
    kind: "function",
    meaning:
      "The fence on every history write: it matches the job row only while this attempt still owns it, so a lost attempt writes nothing.",
    example: "plugins/runner/server/jobs/history.ts",
  },
  {
    lesson: 11,
    name: "reapStaleJobs",
    kind: "function",
    meaning:
      "The 30 s reaper: re-queues a running job whose lease (60 s without a heartbeat) expired, or fails it if it is on its last attempt.",
    example: "plugins/runner/server/jobs/store.ts",
  },
  {
    lesson: 11,
    name: "followTurn",
    kind: "function",
    meaning:
      "How bot.send follows a Turn run by the runner: re-reads Postgres on each changed hint and every 2 s, yielding new Messages until the Turn ends.",
    example: "plugins/bot/server/turn.ts",
  },
  {
    lesson: 12,
    name: "chat.bot_trigger",
    kind: "table/column",
    meaning:
      "One row per Trigger the Router received: id (the source's unique ID; a user Message's id), conversation_id, source, channel, message_id, turn_id (null while it waits in the Conversation queue) and received_at.",
    example: "bot_trigger.turn_id is null: the Trigger waits",
  },
  {
    lesson: 12,
    name: "receive · turnEnded",
    kind: "function",
    meaning:
      "The Router's two calls. receive queues a Trigger and starts a Turn if none runs; turnEnded starts the next Turn for the Triggers that waited.",
    example: "plugins/bot/server/router.ts",
  },
  {
    lesson: 12,
    name: "batchQuietMs · batchLongestMs",
    kind: "type",
    meaning:
      "The batching rule: a Turn's job runs 500 ms after the newest Trigger, and no later than 2500 ms after the first.",
    example: "min(newest + 500, first + 2500)",
  },
  {
    lesson: 12,
    name: "bot_turn_running_bot_id_idx",
    kind: "table/column",
    meaning:
      "A partial unique index on bot_turn(bot_id) where status is running. It backs up the Conversation's row lock: a missed lock is an error, never a second running Turn.",
    example: "plugins/bot/server/db/bot-turn.ts",
  },
  {
    lesson: 12,
    name: "stopBot",
    kind: "function",
    meaning:
      "bot.stop: cancels the running Turn and, in the same transaction, gives it every waiting Trigger, so nothing follows.",
    example: "plugins/bot/server/turn.ts",
  },
  {
    lesson: 12,
    name: "onCancelled",
    kind: "function",
    meaning:
      "A job hook the lease sweep calls for a cancelled job whose attempt died before it ended. The Bot ends the Turn stopped and chains the next one.",
    example: "plugins/runner/server/jobs/define.ts",
  },
  {
    lesson: 13,
    name: "computer",
    kind: "plugin",
    meaning:
      "The plugin that gives each user one Computer on a provider. It exposes operations, not tools.",
    example: "plugins/computer/server/plugin.ts",
  },
  {
    lesson: 13,
    name: "forUser(userId)",
    kind: "function",
    meaning:
      "Returns the handle of a user’s Computer: run, readFile, writeFile, list. Each call wakes the Computer and records activity.",
    example: 'sdk.plugin("computer").forUser(userId)',
  },
  {
    lesson: 13,
    name: "ComputerProvider",
    kind: "type",
    meaning:
      "The seam between the plugin and what runs a sandbox: create, resume, pause, kill, run and file calls. E2B and a fake implement it.",
    example: "plugins/computer/server/provider.ts",
  },
  {
    lesson: 13,
    name: "chat.computer",
    kind: "table/column",
    meaning:
      "One row per user: sandbox_id, template, state (asleep or awake), last_active_at and the synced_* columns.",
    example: "plugins/computer/server/db/computer.ts",
  },
  {
    lesson: 13,
    name: "computer.sleep",
    kind: "function",
    meaning:
      "The self-chaining sleep check job. Each run ends, sleeps the Computer, or queues the next check.",
    example: "plugins/computer/server/plugin.ts",
  },
  {
    lesson: 13,
    name: "addBusyCheck",
    kind: "function",
    meaning: 'Lets another plugin say "the Computer is in use". bot adds one for running Turns.',
    example: "plugins/computer/server/plugin.ts",
  },
  {
    lesson: 13,
    name: "sync_fingerprint",
    kind: "table/column",
    meaning: "The hash of the synced files’ listing. A sleep skips the upload when it matches.",
    example: "chat.computer.sync_fingerprint",
  },
  {
    lesson: 13,
    name: "hasPlugin",
    kind: "function",
    meaning:
      "Tells whether a plugin is on, so bot can leave out the Computer tools when computer is off.",
    example: 'sdk.hasPlugin("computer")',
  },
  {
    lesson: 14,
    name: "create_routine",
    kind: "tool",
    meaning:
      "The Bot's tool that saves a Routine as pending. It runs only once the user approves it.",
    example: "plugins/bot/server/turn.ts",
  },
  {
    lesson: 14,
    name: "routine:<id>:<slot>",
    kind: "ID",
    meaning: "The ID of a scheduled run's Trigger. A slot never makes a second Trigger.",
    example: "plugins/bot/server/routine.ts (fireKey)",
  },
  {
    lesson: 14,
    name: "set_check_in",
    kind: "tool",
    meaning:
      "The Bot's tool that sets a Check-in for itself, at least a minute ahead. It needs no OK.",
    example: "plugins/bot/server/turn.ts",
  },
  {
    lesson: 14,
    name: "handleRoutineWebhook",
    kind: "function",
    meaning:
      "Answers POST /api/routines/webhook/<token>: 202 at once, 404 for an unknown token, 413 for a body over 64 KB, 400 for an Idempotency-Key over 255 characters.",
    example: "plugins/bot/server/routine-webhook.ts",
  },
  {
    lesson: 15,
    name: "start_helper",
    kind: "tool",
    meaning:
      "The Bot's tool that hands a complete task to a Helper: a row in chat.bot_helper and a bot.helper job. A Helper sees only the task.",
    example: "plugins/bot/server/helper.ts",
  },
  {
    lesson: 15,
    name: "helper:<id>:<n>",
    kind: "ID",
    meaning:
      "The ID of a Helper's report Trigger, source helper. A retried finish makes no second one.",
    example: "plugins/bot/server/helper.ts (endHelper)",
  },
  {
    lesson: 15,
    name: "todoList",
    kind: "function",
    meaning:
      "The Bot's running and waiting Helpers, read at the start of a Turn and shown after the time notice. It has no table.",
    example: "plugins/bot/server/helper.ts",
  },
  {
    lesson: 15,
    name: "ask_user",
    kind: "tool",
    meaning:
      "The Computer-use Helper's tool that hands its Screen to the user. It saves the transcript, writes a Computer card and ends the job.",
    example: "plugins/bot/server/hand-off.ts",
  },
  {
    lesson: 15,
    name: "helperDone",
    kind: "function",
    meaning:
      "The user's Done on a waiting Helper: card done, status running, a fresh job that answers the ask_user call.",
    example: "plugins/bot/server/hand-off.ts",
  },
  {
    lesson: 15,
    name: "screenHandler / screenSocket",
    kind: "function",
    meaning:
      "The live view's page proxy and WebSocket hooks, which the Host mounts under /api/screens. The view token in the path is the only sign-in.",
    example: "plugins/bot/server/screen-view.ts",
  },
  {
    lesson: 16,
    name: "profile.md",
    kind: "file",
    meaning:
      "A Bot's Profile: lasting facts about the user, one per line, with no date. Profile facts go into each Turn's prompt, up to the caps.",
    example: "/home/user/bots/<botId>/memory/profile.md: - Prefers short replies",
  },
  {
    lesson: 16,
    name: "log/YYYY-MM.md",
    kind: "file",
    meaning:
      "A Bot's Log for one month: dated events, each with an importance from 1 to 10. The top 30 by score go in each Turn's prompt.",
    example: "- 2026-10-20 (importance 7) Moved to Berlin",
  },
  {
    lesson: 16,
    name: "importance score",
    kind: "function",
    meaning:
      "How a Log line ranks in the prompt: (0.75 + 0.05 × importance) × 0.5^(ageDays / 30). A 30-day half-life.",
    example: "importance 7, 30 days old: 1.10 × 0.50 = 0.55",
  },
  {
    lesson: 16,
    name: "memory.bot-pass",
    kind: "job",
    meaning:
      "The runner job that runs a Bot's post-turn pass after a Turn ends complete or stopped. It returns add, replace and remove operations.",
    example: "key memory-pass:<turnId>",
  },
  {
    lesson: 17,
    name: "bot_prompt_start",
    kind: "table/column",
    meaning:
      "A Bot's stored Prompt start: the exact tool definitions sent and the sections (name, text, hash). Every model call and replay sends these bytes. bot_turn.prompt_start_id points at it.",
    example: "sections: [{ name: 'first_message', text, hash }]",
  },
  {
    lesson: 17,
    name: "bot_turn.input",
    kind: "table/column",
    meaning:
      "The exact newest message a Turn sent, time and Change notes included. Later Turns read it back, so history is never built again.",
    example: "[What changed since your prompt was built]",
  },
  {
    lesson: 17,
    name: "bot_summary",
    kind: "table/column",
    meaning:
      "A Summary of a Bot's older Messages, with its kind (away or mid_turn). Writing one builds a new Prompt start.",
    example: "kind: 'away'",
  },
  {
    lesson: 17,
    name: "describe_tool / run_tool",
    kind: "function",
    meaning:
      "The two tools that reach Deferred tools, listed by name in the first message. describe_tool loads a definition; run_tool calls the tool.",
    example: "run_tool({ name: 'create_routine', args })",
  },
  {
    lesson: 17,
    name: "withCacheControl",
    kind: "function",
    meaning:
      "Adds each provider's cache settings: 1-hour breakpoints on Anthropic, a prompt_cache_key on OpenAI and the ChatGPT plan.",
    example: "prompt_cache_key: 'bot:<botId>'",
  },
  {
    lesson: 17,
    name: "promptHashesOf",
    kind: "function",
    meaning:
      "Hashes every section a model call sends and flags the first one that differs from the previous call: bug, or expected after a new Prompt start.",
    example: "{ name: 'first_message', hash, changed: 'expected' }",
  },
  {
    lesson: 17,
    name: "bot.summarize-away",
    kind: "job",
    meaning:
      "The runner job that writes a Summary 10 minutes after a Turn whose last Step sent over 100,000 tokens. A new Turn cancels it.",
    example: "key summary-away:<botId>",
  },
  {
    lesson: 17,
    name: "bot.warm",
    kind: "route",
    meaning:
      "The procedure the page calls when a Conversation opens or a draft starts, to refill the provider's cache. It skips while a Turn runs or the cache is still warm.",
    example: "at most once a minute per tab",
  },
  {
    lesson: 18,
    name: "reviewToolCall",
    kind: "function",
    meaning:
      "Auto-review of one risky call, before it runs: the review as a recorded activity, its row and usage, then the 15-second wait on a block. A pass returns null.",
    example: "{ error: 'Blocked: …' } or null",
  },
  {
    lesson: 18,
    name: "approvalWaitMs",
    kind: "option",
    meaning:
      "How long a blocked call waits for the user's Approval. Silence counts as no. The review itself has its own 30-second limit.",
    example: "15_000",
  },
  {
    lesson: 18,
    name: "bot_review",
    kind: "table/column",
    meaning:
      "One Auto-review of a call: its tool and input, the reviewer's summary, reason and verdict, and for a block its Approval state and deadline.",
    example: "verdict: 'block', state: 'waiting'",
  },
  {
    lesson: 18,
    name: "chat.secret",
    kind: "table/column",
    meaning:
      "A user's Secret, encrypted with the keyring and bound to its name. Every Bot of the user shares it. The model never reads the value.",
    example: "name: 'GITHUB_TOKEN'",
  },
  {
    lesson: 18,
    name: "maskSecrets",
    kind: "function",
    meaning:
      "Replaces each Secret's value, and its base64 and URL-encoded forms, with *** in a text before the model sees it.",
    example: "maskSecrets(output, ['hunter2']) → '***'",
  },
  {
    lesson: 19,
    name: "skillsPrompt",
    kind: "function",
    meaning:
      "Builds the Skills block of the Prompt start: where Skills live, the rules for writing and using them, then one `- name: description` line per Skill, up to 8,000 characters.",
    example: "- weekly-metrics: Use this when the user asks for the weekly metrics email",
  },
  {
    lesson: 19,
    name: "problemOf",
    kind: "function",
    meaning:
      'Checks one Skill\'s frontmatter and returns why it is not usable, or null. The name must equal the folder, and the description must start with "Use this when".',
    example: "description is missing",
  },
  {
    lesson: 19,
    name: "skillChangesOf",
    kind: "function",
    meaning:
      "Finds the Skills a Turn wrote, from its write and edit calls on the Bot's own SKILL.md files, for the Skill chip.",
    example: "[{ kind: 'saved', name: 'payouts-to-sheet' }]",
  },
  {
    lesson: 19,
    name: "watch_user",
    kind: "tool",
    meaning:
      "The deferred tool that starts a Demonstration: it holds the Screen, posts the Show me card and returns at once.",
    example: "watch_user({ goal, inputs })",
  },
  {
    lesson: 19,
    name: "bot_demonstration",
    kind: "table/column",
    meaning:
      "One Demonstration: its goal, inputs, state, and the name of the Skill it became. Its events and screenshots are deleted after 7 days; the row stays.",
    example: "state: 'saved'",
  },
  {
    lesson: 19,
    name: "draftSkill",
    kind: "function",
    meaning:
      "The drafting pass: one model call, with no tools, that turns a Demonstration's steps and screenshots into a complete SKILL.md. It is metered as skill_draft.",
    example: "draftSkill(deps, demonstration)",
  },
  {
    lesson: 20,
    name: "knowledge",
    kind: "function",
    meaning:
      "The knowledge plugin: a user's Knowledge as plain files in shared/knowledge/ on the Computer. It uses the computer plugin, and it owns the conversion, the cap and the Knowledge routes.",
    example: "knowledge() in plugins/knowledge/server/plugin.ts",
  },
  {
    lesson: 20,
    name: "knowledgeDirectory",
    kind: "file",
    meaning:
      "The folder every Bot reads Knowledge from, inside the shared tree the Computer syncs: /home/user/shared/knowledge.",
    example: "/home/user/shared/knowledge/handbook.pdf.md",
  },
  {
    lesson: 20,
    name: "knowledgePrompt",
    kind: "function",
    meaning:
      "Builds the Knowledge block of the Prompt start: where Knowledge is, how to use it, then one '- path' line per readable path, up to 4,000 characters.",
    example: "- reports/annual-report.pdf.md",
  },
  {
    lesson: 20,
    name: "readablePaths",
    kind: "function",
    meaning:
      "The paths a Bot reads, sorted. A file that has a readable copy is left out, so the Bot reads the .md copy instead of the original.",
    example: "readablePaths(['handbook.pdf', 'handbook.pdf.md']) → ['handbook.pdf.md']",
  },
  {
    lesson: 20,
    name: "knowledgeChangesOf",
    kind: "function",
    meaning:
      "The files a Turn saved under shared/knowledge/ with write, edit or run_tool, for the 'saved to Knowledge' chip. Writes elsewhere, such as memory, are ignored.",
    example: "knowledgeChangesOf(botId, transcript) → [{ botId, path: 'report.md' }] or null",
  },
  {
    lesson: 21,
    name: "last_seq",
    kind: "table/column",
    meaning:
      "The Conversation's newest change number. recordChange bumps it under the row lock, in the same transaction as the change.",
    example: "last_seq 41 → 42 when a Turn starts",
  },
  {
    lesson: 21,
    name: "conversation_change",
    kind: "table/column",
    meaning:
      "The change log: one row per change to a Conversation's thread, with its seq, kind and ref_id. Only the newest 500 are kept.",
    example: "(conversation_id, seq 42, kind 'turn', ref_id <turn id>)",
  },
  {
    lesson: 21,
    name: "recordChange",
    kind: "function",
    meaning:
      "Bumps last_seq and writes one change, inside the caller's transaction. It also deletes the changes older than the newest 500. A change that rolls back gives its number back.",
    example: "recordChange(tx, conversationId, { kind: 'message', refId, at })",
  },
  {
    lesson: 21,
    name: "changesSince",
    kind: "function",
    meaning:
      "The changes after a cursor, oldest first, or reload when the log no longer holds them all or the cursor is past the newest.",
    example: "changesSince(db, conversationId, 41) → changes 42, 43 or { reload: true }",
  },
  {
    lesson: 21,
    name: "bot.changes",
    kind: "route",
    meaning:
      "The oRPC route a tab calls on a hint. It returns the changes after `since`, each with what it points at now.",
    example: "bot.changes({ botId, since: 41 })",
  },
  {
    lesson: 21,
    name: "hintChanged",
    kind: "function",
    meaning:
      "Publishes the data-less { type: 'changed' } hint on the Conversation's channel. It never throws.",
    example: 'hintChanged(deps, conversationId) → {"type":"changed"}',
  },
  {
    lesson: 21,
    name: "syncBot",
    kind: "function",
    meaning:
      "The tab's fetch: reads the changes after its cursor and applies them in order, or reloads on a gap. Only one runs per Bot at a time.",
    example: "syncBot(queryClient, orpc, botId)",
  },
  {
    lesson: 21,
    name: "safetyFetchMs",
    kind: "constant",
    meaning:
      "How often a tab with a running Turn fetches the changes when no hint has come: 30 seconds.",
    example: "safetyFetchMs = 30_000",
  },
];

(function () {
  const upto = Number(document.currentScript?.dataset.upto ?? Infinity);
  const esc = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const entry = (n) =>
    `<div class="n"><code>${esc(n.name)}</code> <span class="kind">${esc(n.kind)} · lesson ${n.lesson}</span><div>${esc(n.meaning)}</div><div class="ex">e.g. ${esc(n.example)}</div></div>`;
  window.renderNames = (el, max = Infinity) => {
    el.innerHTML = window.NAMES.filter((n) => n.lesson <= max)
      .map(entry)
      .join("");
  };
  if (!Number.isFinite(upto)) return;
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.createElement("button");
    btn.className = "names-btn";
    btn.type = "button";
    btn.textContent = "Names?";
    btn.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "names-panel";
    panel.hidden = true;
    window.renderNames(panel, upto);
    btn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
    });
    document.body.append(panel, btn);
  });
})();
