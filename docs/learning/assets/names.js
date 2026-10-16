// Every code name the lessons teach, in one list. Lessons load this file with
// <script src="../assets/names.js" data-upto="N"></script> to get the floating "Names?" button,
// which lists the names from Lessons 1..N. reference/names.html renders the full list.
//
// kind: package · file · function · type · table/column · route
window.NAMES = [
  {
    lesson: 1,
    name: "packages/bot-sdk",
    kind: "package",
    meaning:
      "The Bot SDK: one folder a Host copies in: a core (core/shared, core/server, core/client), plugins (assistant, models), ui/ and extras/.",
    example: "pnpm -F @ai-chat/bot-sdk copy ../my-host/src/lib/bot-sdk",
  },
  {
    lesson: 1,
    name: "core/shared",
    kind: "folder",
    meaning:
      "Code both sides use: base Message parts, Attachments, error codes. Imports only npm packages.",
    example: "core/shared/message-parts.ts",
  },
  {
    lesson: 1,
    name: "core/server",
    kind: "folder",
    meaning:
      "The core's server code: createBotSdk, the handler, the core routers and tables. Plugins (handleChat, the Run) sit in plugins/*/server. Imports only shared.",
    example: "core/server/create-chat.ts",
  },
  {
    lesson: 1,
    name: "core/client",
    kind: "folder",
    meaning:
      "The browser side: createBotSdkClient, plus ChatProvider and hooks in client/react. Reaches server only with import type.",
    example: "core/client/chat-client.ts",
  },
  {
    lesson: 1,
    name: "ui/",
    kind: "folder",
    meaning:
      "The SDK's React components (ui/ and each plugin's ui/). The Host owns them; the copy script copies them only once.",
    example: "ChatView from @ai-chat/bot-sdk/plugins/assistant/ui in routes/_auth/c/$id.tsx",
  },
  {
    lesson: 1,
    name: "@ai-chat/bot-sdk/core/server · /core/client · /plugins/*",
    kind: "package",
    meaning:
      "The entry points in the SDK's package.json (core/server, core/client, and server, client and ui for each plugin); a Host imports nothing else.",
    example:
      'import { createBotSdk } from "@ai-chat/bot-sdk/core/server" in apps/web/src/services.ts',
  },
  {
    lesson: 1,
    name: "sdk.handler",
    kind: "function",
    meaning:
      "The one web-standard handler (Request → Response) the Host mounts under basePath; it routes /rpc/*, /run and the rest.",
    example: "routes/api/chat/$.ts passes every method to sdk.handler(request)",
  },
  {
    lesson: 1,
    name: "routes/api/chat/$.ts",
    kind: "route",
    meaning: "apps/web's catch-all route for /api/chat/*; it holds no chat logic.",
    example: "GET, POST, PUT, PATCH, DELETE, HEAD → sdk.handler(request)",
  },
  {
    lesson: 1,
    name: "import type",
    kind: "type",
    meaning:
      "A TypeScript import that is erased at build, so no code moves. The only way client or ui may reach server.",
    example:
      'import type { CoreRouter } from "../server/routers/index" in core/client/chat-client.ts',
  },
  {
    lesson: 2,
    name: "createBotSdk",
    kind: "function",
    meaning:
      "Builds the Bot SDK for a Host from its options; returns the handler, migrate/start/stop and server-only calls. Builds nothing until first use.",
    example:
      'export const sdk = createBotSdk({ databaseUrl, getUser, keyEncryptionSecrets, basePath: "/api/chat", plugins }) in apps/web/src/services.ts',
  },
  {
    lesson: 2,
    name: "getUser",
    kind: "option",
    meaning:
      "The Host's function from a Request to { id } or null. null answers 401, except for the two public Shared link RPCs.",
    example: "apps/web asks Better Auth for the session and returns { id: session.user.id }",
  },
  {
    lesson: 2,
    name: "basePath",
    kind: "option",
    meaning: "Where the Host mounts the handler; every SDK route sits under it.",
    example: '"/api/chat", so a Run is POST /api/chat/run',
  },
  {
    lesson: 2,
    name: "createChatHandler",
    kind: "function",
    meaning:
      "Makes the one handler over a test SDK context (SdkOver); it picks who answers a request from its path, top rung first.",
    example:
      "createChatHandler(deps, { basePath, getUser }) in test/support/sdk.ts (defined in plugins/assistant/server/over.ts)",
  },
  {
    lesson: 2,
    name: "BotSdkContext",
    kind: "type",
    meaning:
      "The bundle of everything the server code uses: db, runtime, hooks, plugin(id) and more; each plugin keeps its own state (assistantState). It is the test seam.",
    example: 'deps.plugin("models").adapterFor(model.id, credentials, …) in run-plan.ts',
  },
  {
    lesson: 2,
    name: "defaultLimits",
    kind: "option",
    meaning:
      "The assistant plugin's default limits (snapshot interval, Run cap, lease, reaper interval, drain); createBotSdk builds the rest of the context from its options on first use.",
    example: "packages/bot-sdk/plugins/assistant/server/deps.ts",
  },
  {
    lesson: 2,
    name: "createTestSdk",
    kind: "function",
    meaning:
      "The SDK context for tests: the test database and fakes, with nothing that reaches the network.",
    example: "packages/bot-sdk/test/support/deps.ts",
  },
  {
    lesson: 2,
    name: "migrate / start / stop",
    kind: "function",
    meaning:
      "The lifecycle: migrate() at deploy, start() at boot (checks the setup, starts the reaper and jobs), stop() on SIGTERM (503 for new Runs, 250 s drain).",
    example: "apps/web/server/plugins/chat-lifecycle.ts calls sdk.start() and sdk.stop()",
  },
  {
    lesson: 2,
    name: "chat-lifecycle.ts",
    kind: "file",
    meaning: "apps/web's Nitro plugin that calls sdk.start() at boot and sdk.stop() on SIGTERM.",
    example: "apps/web/server/plugins/chat-lifecycle.ts",
  },
  {
    lesson: 3,
    name: "chatCommandSchema",
    kind: "function",
    meaning:
      "The zod schema of the command the browser posts to start a Run. It lives in plugins/assistant/shared, so the browser builds it and the server checks it.",
    example:
      "handleChat parses body.forwardedProps with it; a bad body is 400 error.invalidCommand",
  },
  {
    lesson: 3,
    name: "ChatCommand",
    kind: "type",
    meaning:
      "The command: conversationId, parentId, text (left out for a regenerate), model, attachmentIds, webSearch, tools.",
    example: '{ conversationId: "c7…", parentId: "a2", text: "Thanks", model: "anthropic:…" }',
  },
  {
    lesson: 3,
    name: "forwardedProps",
    kind: "type",
    meaning:
      "The field in TanStack AI's request body that carries the app's own data. The server reads only this field.",
    example:
      "fetchServerSentEvents(chatUrl, () => ({ body: command.current })) puts the command there",
  },
  {
    lesson: 3,
    name: "parentId (command)",
    kind: "type",
    meaning: "The Message the new one continues; null starts a new root.",
    example: "send → a2 · edit q2 → a1 · regenerate a2 → q2",
  },
  {
    lesson: 3,
    name: "branchFrom",
    kind: "function",
    meaning:
      "Gives the Messages above messageId (history) and the last of them as parentId, for an edit or a regenerate.",
    example:
      'branchFrom([q1,a1,q2,a2], "q2") → { parentId: "a1", history: [q1, a1] } (plugins/assistant/client/chat.ts)',
  },
  {
    lesson: 3,
    name: "fetchServerSentEvents",
    kind: "function",
    meaning:
      "TanStack AI's connection that POSTs a Run to chatUrl and reads the reply as server-sent events.",
    example:
      "built once in plugins/assistant/client/react/conversation-run.ts, with fetchClient: runFetch",
  },
  {
    lesson: 3,
    name: "run (useConversationRun)",
    kind: "function",
    meaning:
      "Sets command.current, then calls sendMessage (with text) or reload (without). When the Run ends, it reloads the Active Branch from the server.",
    example: "send → run(lastId, text); startBranch → run(parentId, text?, history)",
  },
  {
    lesson: 3,
    name: "chatUrl",
    kind: "route",
    meaning:
      "Where a Run is posted (POST) and joined (GET ?runId=), made by createBotSdkClient (the assistant plugin adds it) from the Host's baseUrl.",
    example:
      "createBotSdkClient({ baseUrl: origin + '/api/chat', plugins }).chatUrl → …/api/chat/run",
  },
  {
    lesson: 3,
    name: "loadPath(deps, conversationId, leafId)",
    kind: "function",
    meaning:
      "Loads all of a Conversation's Messages and walks up from a leaf to a root, to rebuild the history on the server. handleChat, titles, Memory, Shared links and Artifacts use it.",
    example:
      "run-plan.ts: loadPath(deps, owned.id, input.leafId) → the history for the Model (core/server/chat/message-tree.ts)",
  },
  {
    lesson: 4,
    name: "handleChat",
    kind: "function",
    meaning:
      "Answers POST /api/chat/run: runs every check that can refuse, then writes the Messages in one transaction and starts the Run.",
    example: "packages/bot-sdk/plugins/assistant/server/chat/handle-chat.ts",
  },
  {
    lesson: 4,
    name: "refuse(status, code, params)",
    kind: "function",
    meaning: "Builds a refusal: an HTTP status and a body { code, params }. Nothing is written.",
    example: 'refuse(404, "error.conversationNotFound")',
  },
  {
    lesson: 4,
    name: "errorMessages",
    kind: "file",
    meaning: "The English text for each error code; the client looks a code up here.",
    example:
      '"error.replyStreaming" → "A reply is still streaming in this Conversation" (core/shared/i18n/en/errors.ts)',
  },
  {
    lesson: 4,
    name: "runFetch",
    kind: "function",
    meaning:
      "The client's fetch for a send: turns a refused response into RateLimitedError, ModeratedError or RefusedError.",
    example: "core/client/rate-limit.ts",
  },
  {
    lesson: 4,
    name: '.for("update")',
    kind: "function",
    meaning: "Drizzle's SELECT … FOR UPDATE: locks the Conversation row so concurrent sends queue.",
    example: "handleChat locks the conversation row before it looks for a streaming Message",
  },
  {
    lesson: 4,
    name: "error.replyStreaming",
    kind: "route",
    meaning:
      "The 409 code when a Message in the Conversation is still streaming (one Run per Conversation, ADR 0002).",
    example: "a second tab sends while the first reply streams → 409",
  },
  {
    lesson: 4,
    name: "startRun",
    kind: "function",
    meaning:
      "Runs one assistant Message after the transaction commits: reads chat() to the end, appends each chunk to the run log, snapshots parts to Postgres and saves the final status in finally.",
    example: "plugins/assistant/server/chat/run.ts, called at the end of handleChat",
  },
  {
    lesson: 5,
    name: "chat()",
    kind: "function",
    meaning: "TanStack AI's call to the Model. It returns an async stream of chunks.",
    example: "chat({ adapter, messages, abortController, tools, systemPrompts }) in run-plan.ts",
  },
  {
    lesson: 5,
    name: "RunStreams",
    kind: "type",
    meaning:
      "One append-only, replayable chunk log per Run: open, append, close, read(runId, offset).",
    example:
      "createMemoryRunStreams() in run-streams.ts; createRedisRunStreams() in redis-run-streams.ts",
  },
  {
    lesson: 5,
    name: "START",
    kind: "option",
    meaning: "The offset that reads a run log from its first entry.",
    example: 'START = "-1"; read(runId, START) gives every chunk',
  },
  {
    lesson: 5,
    name: "runStreamDurability",
    kind: "function",
    meaning:
      "Adapts one Run's log to TanStack AI's StreamDurability so resumeServerSentEventsResponse can read it. Only read works.",
    example: "runStreamDurability(deps.runStreams, assistantMessageId, START) in handle-chat.ts",
  },
  {
    lesson: 5,
    name: "resumeServerSentEventsResponse",
    kind: "function",
    meaning: "TanStack AI helper that turns a log read into a server-sent events Response.",
    example: "the POST /run response in handleChat",
  },
  {
    lesson: 5,
    name: "snapshotIntervalMs",
    kind: "option",
    meaning: "How often the Run writes heartbeatAt, and the parts if they changed.",
    example: "1_000 in defaultLimits (plugins/assistant/server/deps.ts)",
  },
  {
    lesson: 5,
    name: "heartbeatAt",
    kind: "table/column",
    meaning:
      "The Run's lease: the last sign of life from the process running a streaming Message, written on every snapshot tick even with no new chunk.",
    example: "last beat 40 s, lease 30 s → reaped once now − 30 > 40",
  },
  {
    lesson: 5,
    name: "runCapMs",
    kind: "option",
    meaning: 'The hard time limit of one Run; hitting it ends the Run as error "timed_out".',
    example: "5 * 60_000 in defaultLimits (deps.ts)",
  },
  {
    lesson: 5,
    name: "shutdownAbort",
    kind: "function",
    meaning: 'The abort reason stop() uses; a Run aborted with it ends as error "interrupted".',
    example: "run.abort(shutdownAbort) in lifecycle.ts",
  },
  {
    lesson: 6,
    name: "handleJoin",
    kind: "function",
    meaning:
      "Answers GET /run?runId=…: checks that the user owns the Run's Conversation, then replays the Run's log from the start (or Last-Event-ID) and follows it until it closes.",
    example:
      "packages/bot-sdk/plugins/assistant/server/chat/join-run.ts; a reloaded tab joins the streaming Message whose id is the runId",
  },
  {
    lesson: 6,
    name: "stopRun",
    kind: "function",
    meaning:
      'Stops a Run from any process: writes cancel_requested_at and publishes "stop" on run:<id>:cancel. It never writes status, unless the lease has run out.',
    example: "chat.stop({ messageId }) in routers/chat.ts calls stopRun(context.sdk, id)",
  },
  {
    lesson: 6,
    name: "cancel_requested_at",
    kind: "table/column",
    meaning:
      "The Stop note on chat.message. The owner reads it on each 1 s tick, so it catches a Stop whose signal was missed.",
    example: "stopRequested(deps, runId) → true, so the owner aborts and saves stopped",
  },
  {
    lesson: 6,
    name: "reapStaleRuns",
    kind: "function",
    meaning:
      'Ends every streaming Message whose heartbeat is empty or older than now − leaseMs as error "interrupted", cancels its running calls and ends its log.',
    example: "plugins/assistant/server/chat/run.ts; lifecycle.ts runs it in start() and every 30 s",
  },
  {
    lesson: 6,
    name: "HEARTBEAT_LEASE_MS",
    kind: "option",
    meaning:
      "How long a Run may go without a heartbeat before it counts as ended (30 000 ms). defaultLimits.leaseMs holds the same value for the reaper.",
    example: "heartbeatExpired(row) in stop.ts",
  },
  {
    lesson: 6,
    name: "memoryRuntime / redisRuntime",
    kind: "function",
    meaning:
      "The two BotSdkRuntime values: runStreams (the logs), pubsub (signals) and counters, kept in process memory or shared through Redis.",
    example: "apps/web/src/services.ts picks redisRuntime when REDIS_URL is set",
  },
  {
    lesson: 6,
    name: "drainMs",
    kind: "option",
    meaning:
      'How long stop() lets local Runs finish (250 000 ms) before it aborts them as error "interrupted". New Runs get 503 meanwhile.',
    example: "defaultLimits in deps.ts; sdk.stop() on SIGTERM",
  },
  {
    lesson: 7,
    name: "message.parentId",
    kind: "table/column",
    meaning:
      "The Message this one continues; null for a root. The only link in the tree, and it points up.",
    example: 'q2b.parentId = "a1" in packages/bot-sdk/core/server/db/core-schema.ts',
  },
  {
    lesson: 7,
    name: "conversation.activeLeafId",
    kind: "table/column",
    meaning:
      "The leaf of the Conversation's Active Branch. It becomes null if that Message is deleted (set null).",
    example: 'activeLeafId = "a2b" shows q1, a1, q2b, a2b',
  },
  {
    lesson: 7,
    name: "pathTo(nodes, leafId)",
    kind: "function",
    meaning:
      "Walks parentId up from a leaf and reverses, giving the Branch oldest first. It returns [] for a null or unknown leaf.",
    example: 'pathTo(TREE, "a2b") → q1, a1, q2b, a2b (core/shared/chat/branches.ts)',
  },
  {
    lesson: 7,
    name: "loadActiveBranch(deps, conversationId, leafId)",
    kind: "function",
    meaning:
      "Gives the Active Branch for the client: pathTo from activeLeafId, plus each Message's sibling position and Attachments.",
    example:
      "the conversation.get RPC in plugins/assistant/server/routers/conversation.ts (loadActiveBranch in chat/store.ts)",
  },
  {
    lesson: 8,
    name: "siblingPosition(nodes, node)",
    kind: "function",
    meaning:
      "Where a Message sits among the Messages with the same parentId, oldest first; drives the ‹ n/m › arrows.",
    example:
      'q2b → { index: 1, count: 2, previousId: "q2", nextId: null } (core/shared/chat/branches.ts)',
  },
  {
    lesson: 8,
    name: "newestLeaf(nodes, id)",
    kind: "function",
    meaning: "The newest leaf anywhere below a Message; a Branch switch makes it the activeLeafId.",
    example: 'newestLeaf(TREE, "q1") → "a2b" (m6), not a1b (m4)',
  },
  {
    lesson: 8,
    name: "conversation.switchBranch",
    kind: "route",
    meaning:
      "RPC that sets activeLeafId to newestLeaf under a Message; CONFLICT while a reply streams; doesn't bump lastMessageAt.",
    example:
      "orpc.conversation.switchBranch({ messageId }) (plugins/assistant/server/routers/conversation.ts → chat/store.ts switchBranch)",
  },
  {
    lesson: 8,
    name: "siblings",
    kind: "type",
    meaning:
      "The SiblingPosition loadActiveBranch adds to each Active Branch Message; 1 of 1 on the client while a reply streams.",
    example: 'messageSiblings(message) → { index: 0, count: 2, previousId: null, nextId: "a1b" }',
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
      "One plugin's folder, in shared, server, client and ui. Today there are two: models and assistant.",
    example: "plugins/assistant/server/plugin.ts",
  },
  {
    lesson: 9,
    name: "BotSdkPlugin",
    kind: "type",
    meaning:
      "A plugin's plain object: id, requires, router, routes, rateLimits, init, start, stop, databaseHooks, deleteUser, exportUser and rotateKeys.",
    example: 'assistant() returns one with id "assistant" and requires ["models"]',
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
    example: "orderPlugins([assistant, models]) → models, assistant",
  },
  {
    lesson: 9,
    name: "fields",
    kind: "table/column",
    meaning:
      "A plugin's part of a core table: Drizzle column builders and an index callback, composed into conversation or message.",
    example: "plugins/assistant/server/schema.ts → fields.conversation.columns.model",
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
