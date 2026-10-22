# Research: which shared code do Bots actually use?

Ticket: [#783](https://github.com/Daanish2003/bot-sdk/issues/783) (child of map [#781 Wayfinder: Bot-only platform](https://github.com/Daanish2003/bot-sdk/issues/781)).
Researched: 2026-10-22 against `main` at `a1e9441f`. Source: the code itself. Paths are under `packages/bot-sdk/` unless they start with `apps/`, `packages/auth` or `examples/`.

"Bot code" means `plugins/{bot,channel,computer,knowledge,memory,runner,skills,models}` and the `apps/web` `/bots` routes. "The assistant" means `plugins/assistant` and the assistant routes in `apps/web` (`/c`, `/p`, `/share`, the `_auth` shell).

## TL;DR

- **Assistant columns:** Bot code reads or writes none of the assistant's columns on `conversation`/`message`, and never uses the `awaiting_approval` status. The one exception is `available-models`, which reads `conversation.model`. A Bot Conversation has none, so that read only finds assistant rows. Bot code does use the core `role`, `parts`, `status` ("complete"), `createdAt` and `activeLeafId` (through `appendMessage`).
- **`StoredParts`:** Bot rows are typed as the assistant's `StoredParts`, which already carries Bot-only fields (`timeZone`, `channel`, `subject`). The Bot `control` part and `reactions` are cast in with `as unknown as` (`plugins/bot/server/store.ts:56-70`).
- **Message tree:** Bot code uses only `appendMessage`. It never uses Branches (`loadPath`, `pathTo`, `siblingPosition`).
- **Export and delete:** `UserExport` is defined in `assistant/server/export-user.ts` and imported by core. Bot data is exported only as `bots` (id, name, model, createdAt, messages) and `botMemory`. Bot delete goes through plugin `deleteUser` hooks and FK cascades.
- **`createBotSdkOver`:** it lives in the assistant, and all 118 harness test files and all 13 `eval:*` scripts use it. The only assistant-only piece it adds is `assistantOver(...)`. `createChatHandler` throws without the assistant. `apps/web` does not use it.
- **Background Model:** no Bot path reads it. Its only runtime reader is the assistant's title job.
- **Ban:** it already stops Bot Turns. `admin-ban.ts` calls both `stopRuns` and `bot.stopTurns`, and `isUserBlocked` gates routine, check-in, webhook and email Triggers.
- **Core attachments and run streams:** no Bot code uses them. Bot files use the blob store instead.
- **Rate limits:** the only rule Bot code uses is `attachmentUpload`, through the Knowledge uploads.
- **`ChatPage`:** only `bots` and `keys` are reached from Bot code. Bot code also has one "back to assistant" `new` link.

## 1. Assistant columns on `conversation` / `message`, and `awaiting_approval`

**How the tables are put together**

- `core/server/db/schema.ts:42-53` builds both tables from core columns plus `assistantSchema.fields.*.columns`.
- The assistant's columns are defined in `plugins/assistant/server/schema.ts`:
  - `conversation` (lines 46-63): `model`, `reasoning_effort`, `project_id`, `tool_settings`, `temporary`.
  - `message` (lines 66-93): `model`, `reasoning_effort`, `usage`, `context_start_id`, `cancel_requested_at`, `heartbeat_at`, `run_number`, `thread_id`, `interrupted_run_id`, `hidden_at`, `hidden_reason`.
  - A CHECK keeps `conversation.model` set on every assistant Conversation (`schema.ts:48-49,125`).
- Some columns that sit in core are assistant features: `pinnedAt` and `archivedAt` (`core/server/db/core-schema.ts:55-57`), `rating`/`ratedAt` (`:87-90`) and `searchText` (`:85`). So are three indexes: the pinned and archived ones (`:105-112`) and the title and search trigram/FTS ones (`:113,120-128`).

**What Bot code touches**

- None of the assistant columns. A grep of every Bot plugin for each column name finds:
  - `heartbeatAt` only on the runner's own `job` table (`plugins/runner/server/db/job.ts:42`).
  - `reasoningEffort` only in the display component `plugins/models/ui/chat/usage-info.tsx:12-50`.
  - `projectId` only in `plugins/models/client/react/new-conversation-model.ts:13-16`, which only the assistant UI uses.
- Bot code reads no `pinnedAt`, `archivedAt`, `rating`, `ratedAt` or `errorReason`.
- Bot code does read `searchText` indirectly, through `searchTextOf` from `core/shared/message-parts.ts:61`. Callers: `plugins/bot/server/{choice,review,store,summary,turn}.ts` and `plugins/memory/server/bot-pass.ts:8`. `appendMessage` also writes it (`core/server/chat/message-tree.ts:50`).
- **The one read of `conversation.model`** is `plugins/models/server/available-models.ts:83-90`. Its comment says "a Bot's Conversation has none". See section 5.
- **`awaiting_approval`:**
  - It is defined in `core-schema.ts:31` (the `message_status` enum), `core/shared/message-parts.ts:51` (the tool_call state) and `core/server/chat/hooks.ts:59` (`RunEnding`).
  - Its users are all assistant files (`assistant/server/chat/{approval,end-run,run-plan,run}.ts`, `routers/chat.ts`, `export-markdown.ts`, `shared/chat/*`, `ui/chat/tool-call-row.tsx`, `client/react/conversation-run.ts`) and their tests.
  - Bot Messages are always written with `status: "complete"` (`bot/server/store.ts:149`, `bot/server/turn.ts:423`, `channel/server/inbound.ts:90`).
- **Core columns Bot code does use:**
  - `id`, `userId` and `kind` on `conversation`. The insert is at `bot/server/store.ts:186`.
  - `activeLeafId` and `lastMessageAt`, through `appendMessage`.
  - On `message`: `conversationId`, `parentId` (written by `appendMessage`), `role` (filtered all over the Bot plugins, e.g. `bot/server/turn.ts:851,893`), `parts`, `status` and `createdAt`.
  - `lastSeq` and `conversation_change` (`core/server/db/conversation-change.ts`), through the change log (section 7).

**What would break if the assistant columns were dropped:** `available-models.ts:83-90` (its `conversation.model` read) and `models/ui/chat/usage-info.tsx` (only a type and its display).

## 2. `StoredParts` and the Message tree

**`StoredParts`**

- It is defined in `plugins/assistant/shared/message-parts.ts:123-139` as `schemaVersion` 1-5, a `parts` array over the assistant's part union, plus three fields: `timeZone`, `channel: "email"` and `subject`. All three are commented as Bot fields (spec #761).
- Core types the `message.parts` column with it, as a type-only import: `core/server/db/core-schema.ts:12-13,80`.
- **Bot code never imports `StoredParts`.** It types parts as `MessageRow["parts"]`:
  - `textParts` writes `{ schemaVersion: 1, parts: [{type:"text"}], timeZone? }` (`bot/server/store.ts:46-48`).
  - `controlParts` adds a Bot `control` part and `reactions` through `as unknown as MessageRow["parts"]`. The comment explains why: "The column is typed as the assistant's parts union until the row types are composed from the plugins" (`bot/server/store.ts:50-70`).
  - Channel spreads `channel: "email"` and `subject` into `textParts(...)` (`channel/server/inbound.ts:89`).
- The base part schemas Bot code uses are in core, not the assistant:
  - `textPartSchema` (`core/shared/message-parts.ts:9`), used at `bot/shared/rich-control.ts:3,65`.
  - `searchTextOf` (`:61`).
- Bot code never uses the assistant's part types (`web_search`, `generated_image`, `artifact`, `past_chats_search`, the assistant's `tool_call`).
- **What would break if `StoredParts` were removed:**
  - `core-schema.ts:13`, whose type only.
  - Test support: `test/support/conversations.ts:1` and `test/support/generated-images.ts:2` import `storedParts`.
  - `apps/web/e2e/admin.spec.ts:13` imports `storedParts`.

**Message tree**

- `core/server/chat/message-tree.ts` exports `loadMessages` (`:15`), `loadPath` (`:20`) and `appendMessage` (`:34`).
- Bot code uses only `appendMessage`:
  - `bot/server/store.ts:15,146`
  - `bot/server/turn.ts:5,419`
  - `channel/server/inbound.ts:3,87`
- `appendMessage` locks the Conversation row, inserts the row with `parentId = activeLeafId`, moves the leaf, and records a change (`message-tree.ts:34-62`). Bot threads are therefore a single chain: each Message is the child of the last.
- `core/shared/chat/branches.ts` (`pathTo`, `siblingPosition`, `newestLeaf`) is used by `message-tree.ts:3` (`pathTo` in `loadPath` only) and by assistant files (`client/chat.ts:4`, `server/chat/store.ts:10`, `shared/chat/client-message.ts:3`).
- No Bot code calls `loadPath`, `loadMessages`, `pathTo`, `siblingPosition` or `newestLeaf`, or reads `parentId`.

## 3. `UserExport`, export-user and delete-user

**Types and hooks**

- `UserExport` is defined in `plugins/assistant/server/export-user.ts:29-103` as `BotExport & { version: 1; exportedAt; settings; projects; conversations; botMemory; sharedLinks; savedPrompts; artifacts }`.
- Core imports the type in three places: `core/server/user-data.ts:1`, `core/server/plugin.ts:9` and `core/server/create-chat.ts:4`.
- The plugin hooks are typed in `core/server/plugin.ts`: `deleteUser?` (`:146`, with `UserDeleteHooks` at `:76-79`) and `exportUser?` (`:151-155`).
- The SDK exposes `deleteUser` and `exportUser` at `create-chat.ts:119,124,236-237`.

**Export**

- `exportUserData` (`core/server/user-data.ts:60-82`) merges each enabled plugin's `exportUser` in one repeatable-read transaction. It throws when two plugins return the same key (`:72`).
- Three plugins contribute:
  - **assistant:** `assistant/server/plugin.ts:141` calls `exportAssistantData` (`export-user.ts:116-324`).
  - **bot:** `bot/server/plugin.ts:136` calls `exportBots` (`bot/server/store.ts:430-466`). `BotExport = { bots: (Bot & { messages })[] }` (`store.ts:427`), and `Bot` is `{ id, name, model, createdAt }` (`store.ts:29-32`).
  - **memory:** `memory/server/plugin.ts:72-74` returns `botMemory` via `exportBotMemory` (`memory/server/bot-memory.ts:223`). It reads the memory files from the Computer, or returns `[]` when there is none (`:228-233`).
- The memory on/off switch is exported by the assistant, through `sdk.plugin("memory").exportEnabled` (`export-user.ts:210-212`).
- **Bot data that is not exported today:** Turns, Triggers, Routines, Check-ins, Helpers, Reviews, Summaries, Demonstrations, Secrets, the Channel email address, the Computer row, and the Knowledge and Skills files. No `exportUser` hook exists in channel, computer, knowledge, skills, runner or models.
- **Routes:**
  - The core serves `GET <basePath>/export` (`create-chat.ts:147-160`).
  - The client gets it from `exportUrl` (`core/client/chat-client.ts:71`).
  - The button is `ui/settings/export-data-button.tsx:16`.
  - `apps/web` serves it through `apps/web/src/routes/api/chat/$.ts:8`, with `basePath "/api/chat"` (`apps/web/src/services.ts:98`).

**Delete**

- `deleteUserData` (`core/server/user-data.ts:20-50`) runs one transaction with events muted. In order:
  1. Each plugin's `deleteUser.before`, in reverse dependency order.
  2. `deleteConversations(...)` for every remaining Conversation of the user (`:29`).
  3. Unused attachments.
- After the commit it deletes the blobs, then runs each plugin's `after`. Errors in `after` are logged and swallowed.
- There is no FK to the Host's user table. `user_id` is plain text (e.g. `bot/server/db/bot.ts:13`).
- What each plugin's `before` hook deletes:
  - **bot** (`bot/server/plugin.ts:126-135`):
    - First it cancels fires, check-ins and helpers (`routine.ts:55`, `check-in.ts:159`, `helper.ts:800`).
    - Then `botUserDelete.before` (`store.ts:410-424`) deletes `bot_secret` by user and deletes the user's `kind = "bot"` Conversations.
    - The cascades follow from the Conversation (`bot.conversation_id`, `bot.ts:16-19`; `bot_trigger`, `bot-trigger.ts:40`). From `bot.id` they reach `bot_turn`, `bot_routine`, `bot_check_in`, `bot_helper`, `bot_review`, `bot_summary`, `bot_prompt_start`, `bot_demonstration` and `channel_email_address`.
  - **computer** (`computer/server/plugin.ts:446-459`): cancels sleep jobs and deletes the `computer` row. Its `after` kills the sandbox and deletes the archive blob. Knowledge and Skills files live on the Computer.
  - **memory** (`memory/server/plugin.ts:66-71`): deletes `memory_settings`.
  - **models** (`models/server/delete-user.ts:11-17`): deletes `user_credentials` and `usage`.
  - **assistant** (`assistant/server/delete-user.ts:22-35`): deletes its Conversations, then `project`, `mcp_connection`, `user_settings` and `saved_prompt`.
  - **channel** and **runner** have no hook.
- **Host wiring:**
  - Better Auth's `beforeDelete` calls `hooks.deleteChatData` (`packages/auth/src/index.ts:234-247`).
  - That is wired to `sdk.deleteUser` (`apps/web/src/services.ts:74`).
  - The UI is `apps/web/src/components/account-page.tsx:36`.
- **What would break when the assistant is deleted:**
  - The `UserExport` type, at its three core import sites.
  - The `settings` and `conversations` keys of the export.
  - The export of the memory switch, which moves through the assistant's export.

## 4. `createBotSdkOver` and the test harness

**`createBotSdkOver` (`plugins/assistant/server/over.ts:29-55`)**

- It calls core `buildBotSdk(options, given.context)` (`core/server/create-chat.ts:178`) with `databaseUrl: ""`, so every store comes from `given.context`.
- It passes `keyEncryptionSecrets: given.context.keyring ?? given.models.keyEncryptionSecrets` (`:45`).
- It installs these plugins (`:46-51`):
  1. `modelsOver(given.models)`. Bot code needs it: bot, memory and channel all require `models` (`bot/server/plugin.ts:75`, `memory/server/plugin.ts:62`, `channel/server/plugin.ts:60`).
  2. `runner({ jobs: given.jobs })`. Bot code needs it: bot, memory, computer and channel all require `runner` (`computer/server/plugin.ts:306`).
  3. **`assistantOver(given.assistant)`, the only assistant-only piece.** No Bot plugin `requires` or `uses` `assistant`.
  4. `...given.plugins`.
- It returns `{ ...given.models, ...context }` as `SdkOver = BotSdkContext & ModelsDeps` (`:22,55`).
- `GivenContext` is a core type (`create-chat.ts:164`): db, blobStore, runtime, pubsub, counters, logger, events, fetch, clock, keyring, lifecycle, isUserBlocked, rateLimits.
- What `assistantOver` adds (`assistant/server/plugin.ts:113-166`) is all assistant:
  - State: `tools`, `mcpServers`, `artifacts`, a Tavily `searchClient`, `runStreams`, `runs` and `limits`.
  - Routes: `/run`, generated images and MCP connect.
  - Rate limits: `runStart`, `sharedLinkView` and `rating`.
  - The conversation delete hook, `deleteUser`, `exportUser`, `rotateKeys`, and the reaper start/stop.
- **`createChatHandler` (`over.ts:63-73`)** rebuilds an instance over an `SdkOver`. It re-enables every plugin except models, runner and assistant, and passes `assistant: assistantState(sdk)`, which throws when the assistant is off (`assistant/server/state.ts:32-35`).

**Callers**

- `test/support/deps.ts:13,148` (`createBotSdkOver`).
- `test/support/sdk.ts:10,25` (`createChatHandler`).
- Three tests call `createChatHandler` directly:
  - `test/core/server/chat/error-codes.integration.test.ts:198`
  - `test/core/server/chat/host-hooks.integration.test.ts:640,668`
  - `test/core/server/chat/reply-moderation.integration.test.ts:253`
- **118 test files** import `test/support/deps` or `test/support/sdk` (115 and 101 of them respectively).
- `eval/turn/run.ts:24,189` passes `assistant: {}` and `plugins: [bot()]`.
- `eval/computer/setup.ts:16,78` (`createComputerSdk`, which passes `assistant: {}`) is used by:
  - `eval/turn/{context,ladder}.ts`
  - `eval/channels/run.ts`
  - `eval/knowledge/run.ts`
  - `eval/skills/{run,draft-run,record-fixtures}.ts`
  - `eval/computer/{run,helper,lifecycle}.ts`
  - `eval/safety/run.ts`
  - `eval/memory/bot-run.ts`
- That makes **all 13 `eval:*` scripts** (`package.json:38-50`) depend on `createBotSdkOver`.
- **`apps/web` does not call it.** It uses `createBotSdk` with `assistant({ mcpServers, artifacts: true })` among its plugins (`apps/web/src/services.ts:114-148`). `apps/web/scripts/rotate-keys.ts:33-52` uses `[models(), runner(), assistant()]`.
- `examples/next-prisma/src/bot-sdk/plugins/assistant/server/over.ts` is a vendored copy that nothing calls.

**`test/support/deps.ts` (`createTestSdk`, `:61-152`)**

- The core context it builds (`:77-92`):
  - test db, `postgresBlobStore`, memory pubsub, counters and runStreams
  - a silent logger, a hook emitter and a throwing `fetch`
  - the test keyring, a clock, lifecycle, `isUserBlocked` and `resolveRateLimits()`
- The models deps it builds (`:93-127`): a fake adapter with `withReviewer`, plus throwing image and transcription adapters.
- **The assistant part (`:128-146`):** `searchClient: createFakeSearchClient()`, `tools`, `mcpServers`, `artifacts: false`, `runStreams`, `runs` and test `limits`.
- `memory()` is installed by default (`:147`).
- **Assistant imports:**
  - `type AssistantState` (`:5`)
  - `createBotSdkOver, type SdkOver` (`:13`)
  - `type Limits` from `assistant/server/deps` (`:14`)
  - `TestDepsOverrides` includes `Omit<AssistantState,"limits">` (`:32-51`).

**`test/support/sdk.ts`**

- `createTestChat` (`:21-43`) builds a client with `assistantClient` (`:3,31-39`) and a handler via `createChatHandler`.
- Other support files that import the assistant:
  - `chat-provider.ts:5` (`assistantClient`)
  - `conversations.ts:1` and `generated-images.ts:2` (`storedParts`)
  - `fake-search-client.test.ts:3` (`SearchError`)

**Bot `web_search` and the fake search client**

- Bot `web_search` does not use the harness's fake `searchClient`. It builds its own Tavily client over `deps.fetch`, so Bot tests fake Tavily through `fetch` (`test/core/server/routers/bot-web-search.integration.test.ts:102,121`).
- **Its imports from the assistant** (`plugins/bot/server/web-search.ts:5-11`):
  - `SearchError` (`assistant/server/deps.ts:19`)
  - `createTavilyClient` (`assistant/server/chat/tavily.ts:24`)
  - `searchErrorMessages`, `WebSearchOutput` and `webSearchToolName` (`assistant/shared/chat/web-search.ts:22,30,60`)

**Every import of the assistant from core or the Bot plugins**

| Importer                                   | What it imports                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/server/create-chat.ts:4`             | `type UserExport`                                                                                                                                                                                    |
| `core/server/plugin.ts:9`                  | `type UserExport`                                                                                                                                                                                    |
| `core/server/user-data.ts:1`               | `type UserExport`                                                                                                                                                                                    |
| `core/server/db/core-schema.ts:13`         | `type StoredParts`                                                                                                                                                                                   |
| `core/server/db/schema.ts:3,21`            | `assistantSchema` and `export *`                                                                                                                                                                     |
| `plugins/bot/server/web-search.ts:5-11`    | see above                                                                                                                                                                                            |
| `plugins/models/server/adapters.ts:31`     | `type AspectRatio` (`assistant/shared/chat/generated-image`), used at `:162,218`                                                                                                                     |
| `plugins/models/ui/key-settings.tsx:30-39` | `ArchivedConversationsSection`, `ConnectionsSection`, `DeleteAllConversationsSection`, `InstructionsField`, `SavedPromptsSection`, `SharedLinksSection`, `BackgroundModelSelect`, `ImageModelSelect` |

channel, computer, knowledge, memory, runner and skills have no assistant imports.

## 5. Background Model and `available-models`

**Background Model**

- It is stored as `user_settings.background_model`, an assistant table (`assistant/server/db/settings.ts:10`). Migration `core/server/migrations/20261012195455_rename_background_model/migration.sql:1` renamed it from `title_model`.
- The Host default is the models plugin option `defaultBackgroundModel` (`models/server/plugin.ts:58,126,239,273-274,300-308`; `models/server/types.ts:143`). `apps/web` sets it at `apps/web/src/services.ts:120`.
- **The only runtime reader is the assistant title job:** `assistant/server/chat/title.ts:68-69`.
- Other readers are the settings store and router (`assistant/server/settings/store.ts:15-25,49-57`; `routers/settings.ts:15,21-34`), the export (`export-user.ts:123,266`), the `models.list` response field (`available-models.ts:110`) and the UI (`assistant/ui/settings/background-model-select.tsx`, `image-model-select.tsx:33`).
- **No Bot path reads it.** The Bot memory pass uses the Bot's own model: `memory/server/bot-pass.ts:154`, `resolveModelCall(turn.userId, turn.model)`.
- The help text `core/shared/i18n/en/settings.ts:62` says "Used for titles and Memory".

**`available-models`** (`plugins/models/server/available-models.ts`)

- `listAvailableModels` (`:44-116`) sets `defaultModel` to the model of the user's newest Conversation with a non-null `conversation.model`, if that model is still listed (`:83-90,109`). Only assistant Conversations have a model.
- **Bot code uses it:**
  - `bot/server/routers/index.ts:62` checks `bot.create`'s model with `listAvailableModels`.
  - `bot/server/helper.ts:513` and `bot/server/demonstration-draft.ts:168` use `resolveModel` (`:122-134`).
  - `bot/ui/new-bot-dialog.tsx:27` queries `orpc.models.list`.
- **If `conversation.model` is dropped:** the query at `:83-90` no longer compiles, and `defaultModel` loses its "last used" source.

## 6. Ban

- The ban itself is Better Auth admin's `banned` column (`packages/db/src/schema/auth.ts:12`).
- **The Host action** (`apps/web/src/functions/admin-ban.ts:30-68`) calls these after `auth.api.banUser`:
  - `sdk.plugin("assistant").stopRuns(userId)` at `:64` (`assistant/server/plugin.ts:171-174`, which uses `stopUserRuns` at `chat/run.ts:410-416`).
  - `sdk.plugin("bot").stopTurns(userId)` at `:65` (`bot/server/plugin.ts:103-108`), which calls:
    - `stopUserTurns` (`bot/server/turn.ts:496-499`, which stops each Bot's running Turn via `stopBot` at `:480-492`)
    - `stopUserHelpers` (`helper-tools.ts:160`)
    - `stopUserDemonstrations` (`demonstration.ts:435`)
- **While the ban holds**, `isUserBlocked` (`apps/web/src/services.ts:103-109`) is checked by:
  - the Routine fire (`bot/server/routine-fire.ts:87,105`)
  - the Check-in fire (`check-in-fire.ts:73,83`)
  - the Routine webhook (`routine-webhook.ts:88`)
  - inbound email (`channel/server/inbound.ts:68`)
  - Shared links (`assistant/server/share/store.ts:204,260`)
- No `isUserBlocked` check exists in the runner or in the Turn job itself.
- **So Ban already stops a user's Bot Turns, not only `stopRuns`.** What breaks when the assistant goes is line `:64` (`stopRuns`).

## 7. Core attachments, run streams, rate limits, `ChatPage`

**Attachments**

- No Bot code uses them:
  - `core/server/attachments/store.ts`
  - `core/server/db/attachment.ts`
  - `core/server/routers/attachment.ts` (the whole `coreRouter`, `routers/index.ts:4-6`, served at `create-chat.ts:192`)
  - `core/shared/attachments/kinds.ts`
- Their users are assistant files and core (`user-data.ts:4-5,31-38`; `core-schema.ts:14,21,95`). The one client caller is `assistant/ui/chat/attachments.tsx:48`.
- **Bot files use the blob store instead:**
  - `bot/server/files.ts` writes keys `bot-file/<id>` (`:15`) with `blobStore.put`/`get` (`:72,113`). Metadata lives in a `files` control part, found with a jsonb `@>` query (`:98-109`).
  - Channel delivers those files at `channel/server/deliver.ts:222`.
  - Screenshots, Demonstrations, desktop tools and the Computer also use the blob store.
  - The default store is `postgresBlobStore`, so the blob store and `core/server/db/blob.ts` are Bot code.

**Run streams**

- `core/server/chat/run-streams.ts` and `redis-run-streams.ts` are used only by the assistant: `assistant/server/plugin.ts:163`, `end-run.ts`, `run.ts`, `handle-chat.ts`, `join-run.ts` and `state.ts:2`.
- `core/server/plugin.ts:24` says "only the assistant reads its run streams". Core wires them in `runtime.ts:6-7,45`.
- Bot live updates use pubsub instead, through `conversationChannel` (`bot/server/thread-change.ts:40-43`) and the core `/events` SSE route (`core/server/chat/conversation-events.ts`, `create-chat.ts:144`), consumed at `bot/client/react/bot-sync.ts:141-153`.

**Rate limits** (`core/server/rate-limits.ts`)

| Rule                                   | Declared by                                    | Bot code use                                                                                    |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runStart`, `sharedLinkView`, `rating` | assistant (`assistant/server/plugin.ts:81-83`) | none                                                                                            |
| `attachmentUpload`                     | core                                           | **yes**: `/knowledge/upload` and `/knowledge/uploadDocument` map to it (`rate-limits.ts:61-65`) |
| `conversationSearch`                   | core                                           | none (`/search/query` and the past-chats tool are assistant)                                    |
| `credentialSave`, `transcription`      | models (`models/server/plugin.ts:150-151`)     | models                                                                                          |

- The bot, channel, computer, memory, runner and skills plugins declare no rules and never call `sdk.rateLimit`.
- In `core/client/rate-limit.ts`:
  - `runFetch`, `RefusedError` and `rateLimitedErrorOf` are assistant-only.
  - `throwIfRateLimited` wraps every RPC (`chat-client.ts:64`).
  - `RateLimitedError` is used by `models/client/voice.ts:4,31`.

**`ChatPage`** (`core/client/react/provider.tsx:17-24`). `apps/web` maps the targets at `apps/web/src/lib/chat-provider.tsx:15-37`.

| Target         | Route                   | Bot code users                                                                                                                                              |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`          | `/c`                    | `bot-sidebar.tsx:32` (the "back to assistant" link). `models/client/react/new-conversation-model.ts:25` also uses it, but only the assistant uses that file |
| `conversation` | `/c/$id`                | none                                                                                                                                                        |
| `project`      | `/p/$id`                | none                                                                                                                                                        |
| `keys`         | `/settings/keys`        | `models` banners and `model-picker.tsx:151`. The model picker is used by `bot/ui/new-bot-dialog.tsx:10`                                                     |
| `bots`         | `/bots`, `/bots/$botId` | `bot-sidebar.tsx:47`, `new-bot-dialog.tsx:48`                                                                                                               |

`useChatLocation` (`apps/web/src/lib/chat-provider.tsx:54-66`) knows only `/c`, `/p` and `/settings/*`.

**Shared core pieces Bot code does depend on**

- **change-log** (`core/server/chat/change-log.ts`):
  - `recordChange` is used at `bot/server/thread-change.ts:31` and `message-tree.ts:60`.
  - `changesSince` is used at `bot/server/changes.ts:34`.
  - `lastSeqOf` is used at `bot/server/routers/index.ts:89`.
- **conversation-events**: Bot-only in practice. Its docstring is at `:15-17`.
- **pubsub**.
- **hooks types**: `PromptHash` at `bot/server/loop.ts:12`; `HookEmitter` and `UsageEvent` in the models meter (`models/server/meter.ts:7,148`).
- **delete-conversations**: `bot/server/store.ts:3,414` and core `user-data.ts:29`.
- **counters**: it backs `sdk.rateLimit`.
- **The rest:**
  - `core/client/{chat-client,plugin,intl,rpc-error}.ts` and `react/provider.tsx`
  - `core/server/{context,procedures,plugin,rpc-error,create-chat,runtime,rate-limits}.ts`
  - `blob/*`, `credentials/*` and `lib/*`
  - `db/{schema,index,chat-schema,plugin-schema,core-schema,relations,blob,conversation-change}.ts`
  - `shared/{message-parts,uuidv7}.ts` and `shared/i18n`
- Only these `hooks.ts` hooks are assistant: `onRunEnd`, `onSharedLinkChanged` and `onConversationCreated` (fired at `assistant/server/routers/conversation.ts:80` and `share/store.ts:146,188,342`). Core fires `onConversationDeleted` (`delete-conversations.ts:90`).

## 8. Every core file only the assistant uses

No Bot plugin and no `/bots` route depends on these.

| Core file                                                           | Users                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/client/title.ts`                                              | `assistant/ui/shell/top-bar.tsx:2`                                                                                                                                                       |
| `core/client/date-groups.ts`                                        | `assistant/ui/shell/conversation-panel.tsx:2`                                                                                                                                            |
| `core/client/relative-time.ts`                                      | assistant UI: past-chats row, archived conversations, shared links, share dialog, command palette, conversation panel                                                                    |
| `core/client/react/conversation-list.ts`                            | assistant (9 importers); core `conversation-actions.ts:6` and `delete-conversation.ts:6`. It calls the assistant's `orpc.conversation.*` router (`assistant/server/routers/index.ts:18`) |
| `core/client/react/delete-conversation.ts`                          | assistant command palette, header actions, panel, archived list. It navigates `{to:"new"}` (`:31`)                                                                                       |
| `core/client/react/conversation-actions.ts`                         | assistant UI and `ui/chat/archived-notice.tsx:3`, which only `assistant/ui/chat/chat-view.tsx:32` uses                                                                                   |
| `core/client/moderation.ts`                                         | `ModeratedError` is used only in `assistant/client/react/conversation-run.ts`. It is loaded through `core/client/rate-limit.ts:1`, so it is in every client's import graph               |
| `core/server/attachments/store.ts`                                  | assistant attachments/chat/share code; core `routers/attachment.ts`, `user-data.ts`                                                                                                      |
| `core/server/routers/attachment.ts`, `core/server/routers/index.ts` | `coreRouter = { attachment }`; the one caller is `assistant/ui/chat/attachments.tsx:48`                                                                                                  |
| `core/server/db/attachment.ts`                                      | core schema and `user-data.ts` only                                                                                                                                                      |
| `core/shared/attachments/kinds.ts`                                  | about 13 assistant files; core attachments store and router                                                                                                                              |
| `core/server/chat/run-streams.ts`                                   | assistant; core `runtime.ts:7`                                                                                                                                                           |
| `core/server/chat/redis-run-streams.ts`                             | core `runtime.ts:6,45` only (it feeds run streams)                                                                                                                                       |
| `core/shared/chat/branches.ts`                                      | assistant; core `message-tree.ts:3` (`pathTo` in `loadPath`, which Bot code never calls)                                                                                                 |
| `core/shared/search/text.ts`                                        | assistant search router, past chats, query and command palette                                                                                                                           |
| `core/types/html-to-text.d.ts`                                      | `assistant/server/chat/fetch-url-tool.ts:4`                                                                                                                                              |
| `core/shared/i18n/en/time.ts`                                       | `time.*` is used only by `relative-time.ts` and `date-groups.ts`                                                                                                                         |
| `core/shared/i18n/en/share.ts`                                      | `share.*` is not used by Bot code                                                                                                                                                        |

Some files are shared, but parts of them serve only the assistant:

- `core/server/db/core-schema.ts`: `pinnedAt`, `archivedAt`, `rating`, `ratedAt`, `searchText`, the `messageRating` enum, the `awaiting_approval` status value, the pinned/archived/trigram/FTS indexes and the `StoredParts` type.
- `core/server/chat/message-tree.ts`: `loadMessages` and `loadPath`.
- `core/server/chat/hooks.ts`: `onRunEnd`, `onSharedLinkChanged`, `onConversationCreated` and `RunEnding`.
- `core/server/rate-limits.ts`: the `conversationSearch` rule, and the `/attachment/upload` and `/search/query` paths.
- `core/client/rate-limit.ts`: `runFetch`, `RefusedError` and `rateLimitedErrorOf`.
- `core/client/react/provider.tsx`: the `ChatPage` targets `new` (apart from the "back to assistant" link), `conversation` and `project`.

i18n namespaces:

- `bots.*` and `error.*` are Bot code.
- `shell.*` and `chat.*` reach Bot code only through the models model picker (`models/ui/shell/model-picker.tsx`, `models/client/models.ts:45,47`).
- `settings.*` and `pages.*` reach it only through `models/ui/key-settings.tsx` and the core export button, both on `/settings/keys`.
