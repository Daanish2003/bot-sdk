# Bot SDK

A chat feature a Host copies into its own source tree. The SDK is one folder with these parts:

- `core/` (`shared`, `server`, `client`, including `client/react`): runtime code the Host never edits. Updating means copying it again.
- `plugins/<name>/` (`assistant`, `models`): each plugin's `shared`, `server` and `client` are runtime code like `core/`; its `ui/` is the Host's.
- `ui/`, and each plugin's `ui/`: React components the Host owns and may change. They sit on the Host's own shadcn primitives.
- `extras/`: optional adapters (the Trigger.dev runner) the Host owns once copied.
- `package.json`, `README.md` and `NOTICE`: copied alongside, for reference. The Host installs the dependencies listed here.

The SDK assumes nothing about the Host's stack beyond the npm packages below. It knows users only by an opaque id.

## Adopting the SDK

From this repo, run the copy script with the destination folder inside your Host:

```sh
pnpm -F @ai-chat/bot-sdk copy ../my-host/src/lib/bot-sdk
```

The destination is resolved from the folder you ran `pnpm` in. The script:

- replaces `core/` and every plugin's folders except `ui/` on every run, and writes `VERSION` at the destination root with the commit hash and the date it was copied (`commit:` and `date:` lines);
- copies every plugin, whether or not your Host enables it;
- copies each `ui/` folder (the root one and each plugin's) and `extras/` only when that folder is missing at the destination, checked folder by folder, so your edits to components and `theme.css` survive updates;
- copies `package.json`, `README.md` and `NOTICE` to the destination root on every run;
- never copies tests, test helpers or evals (`*.test.*` files and `test`, `tests`, `testing`, `__tests__`, `eval` folders).

Then add one alias to your `tsconfig.json`, pointing at the destination folder:

```json
{
  "compilerOptions": {
    "paths": {
      "@ai-chat/bot-sdk/*": ["./src/lib/bot-sdk/*"]
    }
  }
}
```

Your imports then read exactly like this repo's: `@ai-chat/bot-sdk/core/server`, `@ai-chat/bot-sdk/plugins/models/server`, `@ai-chat/bot-sdk/plugins/assistant/ui`, and so on.

### Updating

1. Run the copy script again. `VERSION` shows the commit you now run. A copy from before plugins kept every screen in the root `ui/`. Your `ui/` and `theme.css` are not replaced, so move the screens that now live in `plugins/*/ui/` out of your root `ui/` and add the SDK's `@source "../plugins/<name>/ui";` lines to your `theme.css`.
2. Your `ui/` is untouched. If the release changed a component you also edited, merge that by hand: diff the new SDK's `ui/` against yours. The client side of a Run (sending, joining a streaming reply, Stop, a moderated refusal, Approval decisions, Ratings and Memory events) lives in `plugins/assistant/client/react/conversation-run.ts` as `useConversationRun`, which `plugins/assistant/ui/chat/chat-view.tsx` calls, so fixes to it come with the copy.
3. Install any new dependencies listed below, then run your type check.

### Updating to generation control

Generation control adds the Instructions field, the reasoning effort control, the context ring, the per-Message token popover and the context marker. No `createBotSdk` options changed. A Host copies `core/` again and runs `chat.migrate()`, which applies the new migration (the example's `db:migrate` runs it).

If your `ui/` folders match the SDK's, the copy is all you need. If it has drifted, port these by hand: copy the SDK's file and reapply your own edits.

Changed components (from before plugins, each at its path today):

- `plugins/assistant/ui/chat/chat-view.tsx`: the context ring and its overflow notice, the context marker, and "Allow for this Conversation" in the approval call.
- `plugins/assistant/ui/chat/message-row.tsx`: the context marker, the per-Message `UsageInfo`, and the approval choice.
- `plugins/assistant/ui/chat/tool-call-row.tsx`: "Allow for this Conversation" next to Approve and Deny.
- `plugins/assistant/ui/chat/search-toggle.tsx`: the composer's toggle is labelled Web (see The Web toggle).
- `plugins/models/ui/key-settings.tsx` (was `pages/key-settings.tsx`): `InstructionsField`, and the credential sections shown only with `byok` on.
- `plugins/assistant/ui/pages/new-conversation.tsx`: the reasoning effort chosen before the first Message.
- `plugins/assistant/ui/shell/top-bar.tsx`: `ConversationReasoningEffort` and `NewConversationReasoningEffort` next to the Model picker.

New components to copy: `plugins/assistant/ui/chat/context-ring.tsx`, `plugins/models/ui/chat/usage-info.tsx`, `plugins/assistant/ui/settings/instructions-field.tsx`, `plugins/assistant/ui/shell/reasoning-effort-select.tsx`.

They need no new shadcn components: `button`, `label`, `popover`, `select`, `textarea` and `tooltip` are already in the list above.

Later `ui/` changes a Host that copied an older SDK also needs to port: the Web toggle and the fetched-page Source chip (#157, `plugins/assistant/ui/chat/search-toggle.tsx` and `plugins/assistant/ui/chat/source-chips.tsx`), the context ring (#123, `plugins/assistant/ui/chat/context-ring.tsx`), the approval choice "Allow for this Conversation" (#159, `plugins/assistant/ui/chat/tool-call-row.tsx`), Connections (#160, `plugins/assistant/ui/settings/connections-section.tsx` and `plugins/models/ui/key-settings.tsx`) and the tools menu (#161, `plugins/assistant/ui/chat/tools-menu.tsx`). Compare each against the SDK's copy with the diff in step 2 of Updating.

From #378 on, Run-protocol fixes ship in `plugins/assistant/client/` (`useConversationRun`) and need no porting. A `chat-view.tsx` copied before #378 holds that logic itself: port the SDK's `ChatThread` once so it calls `useConversationRun`, and later protocol fixes reach it with the copy.

## Dependencies

Install these in the Host. There is one `package.json` for the whole SDK, and versions come from it. The copy script copies every plugin, so a Host installs every group below.

**What `core/` needs:**

- `@tanstack/ai`
- `@tanstack/react-query`, `react`, `sonner`
- `drizzle-orm` and `pg` (the Postgres driver it uses)
- `redis` (the Redis client, used by `redisRuntime()`)
- `undici` and `ipaddr.js`, for the SSRF-guarded `fetch` (`core/server/lib/guarded-fetch.ts`). `undici` pins each connection to the address that was checked, and `ipaddr.js` classifies that address. Install `undici` at the major your Node bundles (7.x on Node 24): undici 8's dispatcher is rejected by Node's built-in `fetch`.
- `aws4fetch`, which signs requests for `s3BlobStore`
- `@orpc/client`, `@orpc/server`, `@orpc/tanstack-query`
- `zod`

The root `ui/` needs nothing beyond `core/`'s packages.

**What the `models` plugin needs (on top of `core/`):**

- the provider packages: `@tanstack/ai-anthropic`, `@tanstack/ai-bedrock`, `@tanstack/ai-byteplus`, `@tanstack/ai-cloudflare`, `@tanstack/ai-gemini`, `@tanstack/ai-grok`, `@tanstack/ai-groq`, `@tanstack/ai-llmgateway`, `@tanstack/ai-lovable`, `@tanstack/ai-mistral`, `@tanstack/ai-ollama`, `@tanstack/ai-openai`, `@tanstack/ai-openrouter`, `@tanstack/ai-vercel-gateway`
- for its `ui/`: `@tanstack/ai-react`, `lucide-react`

**What the `assistant` plugin needs (on top of `core/`):**

- `@tanstack/ai-client`, `@tanstack/ai-compaction`
- `@tanstack/ai-mcp`, pinned at 0.8.1 (the release whose `@tanstack/ai` range matches), the MCP client (`mcpServers` below). The sign-in itself is the SDK's own: the library exports no OAuth helpers. It brings `@modelcontextprotocol/*` and `jose`.
- `html-to-text` (pinned at 10.0.1), which the `fetch_url` tool uses to turn an HTML page into text. Maintained, MIT, about 15M weekly downloads; the other candidates were `turndown` (converts to Markdown, not text), `@mozilla/readability` (needs a DOM, e.g. `linkedom`) and `node-html-parser`.
- for Knowledge's text extraction: `cheerio`, `htmlparser2`, `csv-parse`, `mammoth`, `pdfjs-dist`, `@thednp/dommatrix`
- for its `ui/`: `@tanstack/ai-react`, `lucide-react`, and what the `prompt-kit` components need (see below): `class-variance-authority`, `marked`, `react-markdown`, `remark-breaks`, `remark-gfm`, `shiki`, `use-stick-to-bottom`, `@tailwindcss/typography`.

**What the `computer` plugin needs (on top of `core/`):**

- `e2b` (pinned at 2.55.0), the E2B JS SDK. Only `plugins/computer/e2b` imports it, so a Host that does not use that subpath can leave it out.

`core/` imports only npm packages and its own files, so a Host outside this repo can copy and compile it. `examples/next-prisma` is a Host outside this repo that runs it.

## shadcn components

`ui/` and each plugin's `ui/` import these from the Host's `@/components/ui/*` (and `@/lib/utils` for `cn`). Add them with the shadcn CLI, which also installs each component's own dependencies:

- `button`, `dialog`, `input`, `label`, `popover`, `select`, `textarea`, `tooltip`, `attachment`, `hover-card`

The `prompt-kit` components (`chat-container`, `loader`, `markdown`, `prompt-input`, `reasoning`, `scroll-button`, `source`, `system-message`) live in this repo's `packages/ui/src/components/prompt-kit/`. Copy them into your `components/ui/prompt-kit/`, and copy two more files they import: `code-block.tsx` (used by `markdown`) into the same folder, and `packages/ui/src/lib/favicon.ts` to your `lib/favicon.ts` (used by `source`). Change their `@ai-chat/ui/...` imports to your `@/...` alias: `@ai-chat/ui/lib/utils` becomes `@/lib/utils`, and `@ai-chat/ui/components/x` becomes `@/components/ui/x`.

## Tailwind v4

`ui/` and each plugin's `ui/` use Tailwind v4 classes. In your global stylesheet, import Tailwind and then the SDK's `theme.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "./lib/bot-sdk/ui/theme.css";
```

`theme.css` starts with three `@source` lines, `@source ".";`, `@source "../plugins/assistant/ui";` and `@source "../plugins/models/ui";`, which tell Tailwind to scan the root `ui/` folder and each plugin's `ui/` wherever the copy sits. Your shadcn theme variables (`--background`, `--primary`, and so on) must also be defined in your stylesheet. The `prompt-kit` message and reasoning components use the `prose` classes, so add `@plugin "@tailwindcss/typography";` as well.

## Postgres

- The database needs the `pg_trgm` extension. `chat.migrate()` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` before its migrations and fails naming it, so a role allowed to create extensions (or a database that already has it) is needed.
- Knowledge needs the `vector` extension from pgvector 0.8 or later. `chat.migrate()` runs `CREATE EXTENSION IF NOT EXISTS vector` and fails naming pgvector if it can't. If the migrating role can't create it, have a superuser run `CREATE EXTENSION vector` once. The extension's schema must be on the migrating role's `search_path`, because the SDK's `vector` columns refer to the type without a schema.
- The SDK's tables live in the `chat` schema of the Host's database, not in your ORM's schema. Your ORM's migrations never touch them.
- The SDK's migrations are expand-then-contract: they add tables, columns and indexes, and never drop or rename one in the same release. The version still running during a deploy keeps working against the migrated schema.

## File storage: `blobStore`

Attachment bytes go to a `BlobStore`, which `createBotSdk({ blobStore })` takes. Names, types, sizes and owners stay in Postgres either way. The store holds bytes only, under keys the SDK makes up, such as `attachment/<id>`.

- **`postgresBlobStore()`** is the default: bytes in the `chat.blob` table of your database. Leave `blobStore` out and nothing changes. The migration copies the bytes from the old `attachment_blob` table into `chat.blob`.
- **`s3BlobStore({ endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle? })`** keeps bytes in any S3-compatible bucket, such as Cloudflare R2 (`region: "auto"`) or RustFS. It needs an existing bucket: the store never creates one, so the app needs no bucket-admin rights. It is built on `aws4fetch`, and `forcePathStyle` defaults to `true`.

```ts
import { createBotSdk, s3BlobStore } from "@ai-chat/bot-sdk/core/server";

const chat = createBotSdk({
  databaseUrl,
  getUser,
  keyEncryptionSecrets,
  blobStore: s3BlobStore({
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    region: "auto",
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  }),
});
```

- A failed upload leaves no object behind. Deleting a user, and the 24-hour cleanup of unused Attachments, remove their objects after the database commit. A failed object delete is logged and not thrown, so a stray object costs storage but no data, and nothing sweeps it.
- **Switching a running deployment from one store to the other isn't supported**: there is no copy tool, so the Attachments already uploaded stay in the store they went to. Choose the store before you go live.

## Host lifecycle

The server API below is the spec for the SDK (spec #70). Some of it lands in later tickets; until then, `core/server` exports only the parts already built.

```ts
// server: construct at module load (no side effects)
// the Model options (Host Providers, BYOK, Quota, ...) go to `models(...)`, the background jobs
// runner to `runner(...)`, and the assistant's (tools, MCP servers, ...) to `assistant(...)`
const chat = createBotSdk({
  databaseUrl,
  getUser,
  keyEncryptionSecrets,
  basePath: "/api/chat",
  plugins: [models(), runner(), assistant()],
});

// one catch-all route on your framework, for every chat call and the Shared link read
export const handler = (request: Request) => chat.handler(request);

// deploy step, once per deploy
await chat.migrate();

// boot and shutdown
await chat.start();
// drains local Runs for up to 250 s; a SIGTERM listener stops Node from exiting by itself
process.on("SIGTERM", () => void chat.stop().finally(() => process.exit(0)));

// when your app deletes a user
await chat.deleteUser(String(user.id));

// when your app exports a user's data: one JSON-ready document (version 1), never credentials
const copy = await chat.exportUser(String(user.id));

// your own route for a Shared link page
const data = await chat.plugin("assistant").getSharedConversation(token);
```

- `getUser(request)` returns `{ id } | null`. The handler answers 401 when it returns `null`.
- `GET <basePath>/export` answers the signed-in user's export as a JSON download (`chat-export-<date>.json`), the same document as `exportUser`. The `ExportDataButton` in `ui/settings/export-data-button.tsx` calls it.
- `start()` refuses to run while the `chat` schema is behind the bundled migrations.
- `stop()` refuses new Runs with 503 while it drains, then closes the runtime's connections.

## Background jobs: `runner`

The `runner` plugin runs the background work (ADR 0011), such as Knowledge processing and Memory. `assistant` requires it, so a Host lists it: `plugins: [models(), runner(), assistant()]`. It's imported from `@ai-chat/bot-sdk/plugins/runner/server`.

`runner({ jobs })` takes the runner for background work. The default is the in-process runner: it keeps jobs in the `chat.job` table, which the `chat` schema already has, polls it every 2 s, runs two jobs at once and retries a failed job up to three times, after about 10 s and 1 min. `start()` starts it, and `stop()` takes no new jobs and waits for the running ones. Nothing else to configure, and no second database.

A custom runner is any object with `enqueue(name, payload, options?)`, `start()` and `stop()`, and it takes the place of the default. Jobs are internal to the SDK: a Host can't declare its own.

### Trigger.dev workers (optional)

Only a Host that runs its jobs on Trigger.dev needs this. The `bot` plugin refuses to start on it, because a retry there starts a Turn over and would send its Messages again; Knowledge and Memory jobs run on either runner. Every other Host keeps the in-process runner and needs nothing from `extras/`. The SDK never imports `extras/`, so `@trigger.dev/sdk` is a dependency of such a Host alone: install it there with `pnpm add @trigger.dev/sdk`.

`extras/trigger/trigger-runner.ts` is a runner that triggers a Host task. The copy script copies `extras/` only when the destination has none, so your edits survive updates. Wire it in two places:

```ts
// src/trigger/chat-job.ts (the Host's task)
import { task } from "@trigger.dev/sdk";
import { chat } from "@/lib/chat";

export const chatJob = task({
  id: "chat-job",
  run: async ({ name, payload }: { name: string; payload: unknown }) => {
    await chat.plugin("runner").runJob(name, payload);
  },
});

// src/lib/chat.ts (where createBotSdk is called)
export const chat = createBotSdk({
  /* ...as before */
  plugins: [models(), runner({ jobs: triggerJobRunner({ taskId: "chat-job" }) }), assistant()],
});
```

`chat.plugin("runner").runJob(name, payload)` runs a job's handler in the calling process, after validating the payload with the job's schema. It rejects an unknown name or a bad payload, and a handler's error reaches the task, so Trigger.dev's retries apply. The Trigger.dev runner supports `enqueue` only: `cancel`, `status` and `schedule` throw until they are needed. Trigger.dev's idempotency keys also match runs that have finished, so unlike the in-process runner, an `idempotencyKey` can't be reused after its job ends.

## A Computer for Bots: `computer`

The `computer` plugin gives each user one Computer, a real machine where their Bots run shell commands and keep files. It requires `runner`, and it is imported from `@ai-chat/bot-sdk/plugins/computer/server`. Leave it out and Bots run without a Computer: no tools, and no mention of them in the system prompt.

The plugin runs on a provider. The E2B provider is on its own subpath, so a Host that never imports it never loads the `e2b` package:

```ts
import { e2bProvider } from "@ai-chat/bot-sdk/plugins/computer/e2b";
import { computer } from "@ai-chat/bot-sdk/plugins/computer/server";

computer({
  provider: e2bProvider({ apiKey, apiUrl, sandboxUrl, template: "ai-chat-computer-v2" }),
});
```

`apps/web` turns `computer` on only when `E2B_API_KEY`, `E2B_API_URL` and `E2B_SANDBOX_URL` are all set.

A user's Computer is created on their first operation, and with `bot` on, only for a user who has a Bot: `bot` adds that owner check (`addOwnerCheck`), so a Turn that races its user's delete leaves no Computer behind. A plugin that uses the Computer for users without a Bot adds its own check.

### The template

`plugins/computer/template/Dockerfile` is a plain Debian image with no X server. The plugin only expects `/home/user`, `bash` and `tar`, so a Host can pass any template with those. The template's name is its version: change the name with every change to the Dockerfile, and every Computer is rebuilt on its next wake. `apps/web` keeps the name in `computerTemplate` (`src/services.ts`).

Build it into self-hosted E2B with the E2B CLI (no dependency is added; `pnpm dlx` fetches it), from `packages/bot-sdk`, with the three variables above in the environment:

```sh
pnpm dlx @e2b/cli@2.22.0 template create ai-chat-computer-v2 -p plugins/computer/template -d Dockerfile
```

Notes from building it on local E2B Embed:

- The root disk follows the tier's `disk_mb` (see "Root disk size" below). On the default 512 MiB tier, with `nodejs` and `npm` added, the disk had no space left and a sleep's sync failed with "No space left on device".
- The build resumes a snapshot for each Dockerfile step, which can fail with `mmap memfd: cannot allocate memory` when WSL's page cache has filled the memory. Free it (`wsl -d Ubuntu-24.04 -u root -- bash -c 'sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory'`) and build again; finished steps are cached.
- Run only one sandbox at a time while testing: with the 2 GiB of hugepages Embed has here, a second sandbox placed while one is paused or running can fail with "Failed to place sandbox".

### Root disk size

On local E2B Embed a sandbox's root disk follows the team tier's `disk_mb` in Embed's Postgres (`public.tiers`, `base_v1`). The tier ships with `disk_mb = 512`, which gives a root disk of about 787 MB with 245 MB free (`total_disk_size_mb = 990` in `env_builds`). That is why `ai-chat-computer-v1` stays minimal: with `nodejs` and `npm` added, the disk had no space left and a sleep's sync failed with "No space left on device".

Measured on 2026-10-19 (orchestrator `v0.16.202610051633`, the newest Embed release):

- `template create --min-free-disk-mb 2048 --no-cache` is a no-op here. The API stores `free_disk_size_mb = 2048`, but the build phase that would act on it (`ensurefreedisk`, "resize-disk") runs only when the orchestrator's `build-ensure-free-disk-space` feature flag is on. Its default is off, Embed has no LaunchDarkly, and the flag has no environment override. A sandbox from that build still showed 787M.
- The lever that works is the tier's `disk_mb`: the base build phase grows the root filesystem to it (`enlargeDiskAfterProvisioning` in `e2b-dev/infra`). With `UPDATE tiers SET disk_mb = 2560 WHERE id = 'base_v1'` (run in the `postgres` container of `~/e2b`), a `--no-cache` rebuild of `ai-chat-computer-v2` gave `df -h /` = 2.8G size, 269M used, 2.3G available. No Embed restart was needed.
- To revert, set `disk_mb` back to 512 and rebuild under a new template name. The disk size is part of the built template, so changing it needs a rebuild and a new name (per the rule above), and every Computer is rebuilt on its next wake. `ai-chat-computer-v2` is the template built with `disk_mb = 2560`.
- The cap is the tier's `max_disk_size_mb` (25600). Changing tier values is an Embed change, not an SDK one.

Trade-offs of a bigger disk:

- Each pause writes a snapshot to the host's filesystem and Embed refuses a pause that would leave under 1024 MiB free (`PAUSE_ADMISSION_DISK_HEADROOM_MIB`). Preflight wants 20 GiB free (`PF_MIN_FREE_GIB`). A larger root disk makes the worst case snapshot larger (only blocks written are stored, so an unused disk costs little).
- The build takes a little longer. RAM and hugepages are not affected, so the one-sandbox limit stays.
- A Bot that installs anything sizeable still fills a finite disk. The Computer's sync archive (`tar` of `/home/user`) grows with what the Bot keeps, whatever the disk size.
- Node is still not in the template.

### Local E2B Embed (WSL2)

Self-hosted E2B runs in the WSL2 distro `Ubuntu-24.04`, in `~/e2b` (its own Docker Engine, not Docker Desktop). Start it, and again after any Windows or WSL restart:

```sh
wsl -d Ubuntu-24.04 -- bash -c 'cd ~/e2b && docker compose up -d --wait'
```

The three variables come from the `ready` container:

```sh
wsl -d Ubuntu-24.04 -- bash -c 'cd ~/e2b && docker compose exec -T ready cat /run/e2b/sdk.env'
```

It prints `E2B_API_KEY`, `E2B_API_URL=http://localhost:3000` and `E2B_SANDBOX_URL=http://localhost:3002` (and a dashboard URL the SDK doesn't need). Gotchas:

- Use `localhost`, not `127.0.0.1`: WSL forwards its ports on `[::1]` only.
- `C:\Users\<you>\.wslconfig` needs `[general]` `instanceIdleTimeout=-1`. Without it WSL stops Ubuntu 15 seconds after the last `wsl.exe` session closes, and Embed dies with it.
- Keep Windows update KB5127648 uninstalled until microsoft/WSL#41917 is fixed: it turns off nested KVM on AMD.

### Pause on timeout

A sandbox is created with a 1 hour timeout and `lifecycle: { onTimeout: "pause" }`, the backstop for a sleep that never runs. Self-hosted E2B (the `e2b-dev/runtime` Embed, orchestrator `v0.16.202610051633`) honours it: a sandbox created with a 5 second timeout was paused when it ran out, and a later connect resumed it with its files. So no fallback is needed there. On an E2B that lacks it, the timeout would kill the sandbox, `resume` would report it `"gone"`, and the next wake would rebuild it from the last synced archive.

### Trying it against a real E2B

With the three variables set and the template built, two test files run the adapter on a real sandbox (they skip without the variables). Run them one file at a time from the repo root, with `TEST_DATABASE_URL` set:

```sh
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism packages/bot-sdk/test/plugins/computer/e2b
```

## Host hooks

`createBotSdk({ hooks })` takes the Host's callbacks into the SDK. Every hook is optional.

```ts
const chat = createBotSdk({
  // ...
  logger, // where the SDK's own failures go; defaults to console
  hooks: {
    // every usage row written on Host credentials: a Run, a title, a web search, a transcription, a generated image or an embedding
    onUsage: (usage) => {
      // usage: { id, userId, kind: "run" | "title" | "web_search" | "transcription" | "image" | "embedding", model, inputTokens,
      //   outputTokens, costMicros, estimated, createdAt }
    },
    // every Run, whichever way it ends, once its ending is written
    onRunEnd: (run) => {
      // run: { userId, conversationId, messageId, runId, ending, reason?, model,
      //   onHostCredentials, hidden }
    },
    // a Conversation a user starts, or continues from a Shared link
    onConversationCreated: (conversation) => {
      // conversation: { userId, conversationId, projectId?, fromSharedLink }
    },
    // a Conversation a user deletes, or each Conversation of a deleted Project
    onConversationDeleted: (conversation) => {
      // conversation: { userId, conversationId, projectId? }
    },
    // a Shared link created, moved to the current Branch, or removed
    onSharedLinkChanged: (link) => {
      // link: { userId, conversationId, change: "created" | "moved" | "removed" }
    },
    // the input check: the user's Message before anything is saved (see Moderation below)
    moderate: (check) => {
      // check: { phase: "input", userId, conversationId, onHostCredentials, text,
      //   attachments: [{ name, mediaType, read() }] } -> { allow: true } | { allow: false, reason? }
    },
  },
});
```

- **Conversations and Shared links.** `onConversationCreated` fires when a user starts a Conversation, and when they continue a Shared link into a new one (`fromSharedLink: true`). `onConversationDeleted` fires once for each Conversation a user deletes, each one a Project delete removes, and each one a delete of all of a user's Conversations removes. `onSharedLinkChanged` reports `created` the first time a Conversation is shared, `moved` when it is shared again (the link moves to the current Branch), and `removed` when it is unshared. Each event fires after its write commits, and not if the write rolls back. Deleting a Conversation drops its Shared link without a `removed` event. `deleteUser` fires none of these events. No payload carries a title or Message text.

- **`onRunEnd`.** `ending` is `complete`, `stopped`, `error` or `awaiting_approval` (a Run that stopped waiting for an Approval). `reason` is set on an `error`: `timed_out`, `interrupted`, or the Provider's error reason (`invalid_key`, `rate_limited` or `provider_error`). `runId` is the Message's id for its first Run, and `<messageId>:<n>` for the Run that continues after an Approval (`n` is 2 or more). `onHostCredentials` says whether the Run ran on Host credentials. `hidden` is `true` when the output check hid the reply (see Moderation). It fires once per Run, from the process that ended the Run: when the Run ends, when the reaper ends an abandoned one as `interrupted`, when `stop()` cuts one off on shutdown, and when a Stop reaches a Run whose process has stopped heartbeating (when a Project is deleted, or a user deletes all their Conversations, the event fires after the transaction commits, and not if it rolls back; `deleteUser` fires nothing). For a Run whose process is gone, `onHostCredentials` is read from the Model's credentials as they are at that moment. No payload carries the reply's text.
- **Delivery.** A hook runs after its change is written. It is never awaited, so a slow hook never delays a Run or a response. It runs at most once, with no retries: design your own delivery if you need one.
- **Failures.** A hook that throws or rejects is logged through the Host's `logger` (`logger.error`). The Run completes as normal.
- **Credentials.** `onUsage` fires only for usage on Host credentials (ADR 0007), never for a Run on the user's own credentials.
- **The SDK's failures.** Failed snapshot writes, Run Log appends, usage rows, title generation, the reaper and the database pool all go to the Host's `logger`. The Redis runtime's connection errors still go to `console`: `redisRuntime()` takes no logger yet.

### Moderation

`moderate` checks the user's Message before anything is saved. It runs after the Message's Attachments are validated and the Quota is checked, and before the Message is written or a Run starts. It is called for every Message the user sends, on Host credentials and on their own. It is not called for a regenerate, which writes no Message, nor for the Run that continues after an Approval.

- **Input.** `check.text` is the Message's text. `check.attachments` holds its image and text Attachments (PDFs are not passed), each with `name`, `mediaType` and `read()`, which resolves to the file's bytes. `check.onHostCredentials` says whether the Run would use Host credentials, so a Host can skip one of the two.
- **Refused.** `{ allow: false, reason? }` answers the request with HTTP 422 and the code `moderated`. The body carries `message` (the `reason`, or a default) and `reason`. Nothing is saved: no Message, no Run and no usage row. The composer keeps the user's text and shows the reason. Their Attachments are cleared with the send.
- **Fails open.** A `moderate` that throws, rejects, or takes longer than 10 seconds lets the Message through and logs the failure through the Host's `logger`. There is no fail-closed setting: to refuse when your own check fails, catch the error and return `{ allow: false }`.
- **No hook, no cost.** With no `moderate`, nothing is called and nothing is added to a send.
- **Output.** `check.phase` is `"output"` when a Run ends, with `text`: the reply text that Run produced, without reasoning or tool-call arguments. It runs once per Run that produced any text, whatever its ending (`complete`, `stopped`, `error`, `awaiting_approval`), after the ending is saved. `{ allow: false }` makes the reply a Hidden reply: its text is erased, the Message shows only that it was hidden (also on a Shared link and in the export), and it is left out of the history the Model sees next. Its usage still counts, the Run ending stays as it was, and `onRunEnd` fires with `hidden: true`. A regenerate makes a new reply as usual. Fails open like the input check. The check runs after the reply has finished streaming, so a reply is visible for the length of the check. A Run that is ended without its owner (the reaper, a Stop of an orphaned Run, or a shutdown) is not checked in this version.

A moderation vendor's scores map to `{ allow }` in the Host:

```ts
moderate: async (check) => {
  if (check.phase !== "input") return { allow: true };
  // `vendor` is the Host's own moderation client; the scores are its per-category values in 0..1.
  const scores = await vendor.score(check.text);
  const flagged = Object.entries(scores).find(([, score]) => score >= 0.8);
  return flagged
    ? { allow: false, reason: `Your message was flagged as ${flagged[0]}.` }
    : { allow: true };
},
```

## Webhooks from the event hooks

The SDK ships no webhooks (ADR 0018). A Host that wants them signs and POSTs from its event hooks. The recipe below uses only Web Crypto and the platform's `fetch`. Its hook sends directly to keep the example short. In your app, have the hook add the event to your own queue and let the queue's worker call `sendWebhook`: a failed send throws, so the queue retries it. The hooks fire at most once, so your queue is what makes delivery reliable.

```ts
import type { EventHooks } from "@/lib/bot-sdk/core/server";

const timestampHeader = "x-webhook-timestamp"; // Unix seconds when the event was sent
const signatureHeader = "x-webhook-signature"; // "sha256=" + hex HMAC-SHA256 of `<timestamp>.<raw body>`
const toleranceSeconds = 300; // a signature older (or newer) than this is rejected

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** The sender: POSTs `{ type, data }` signed with `secret`. A non-2xx answer throws. */
export async function sendWebhook(options: {
  url: string;
  secret: string;
  type: string;
  data: unknown;
}) {
  // The signature covers the exact bytes sent, so the receiver verifies the raw body.
  const body = JSON.stringify({ type: options.type, data: options.data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(options.secret, "sign"),
    encoder.encode(`${timestamp}.${body}`),
  );
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [timestampHeader]: timestamp,
      [signatureHeader]: `sha256=${hex}`,
    },
    body,
  });
  if (!response.ok) throw new Error(`The webhook answered ${response.status}`);
  return response;
}

/** The receiver: returns the event when its signature is valid and fresh, and throws otherwise. */
export async function receiveWebhook(request: Request, secret: string, now = Date.now()) {
  const body = await request.text();
  const timestamp = request.headers.get(timestampHeader) ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) {
    throw new Error("The webhook is stale");
  }
  const hex = /^sha256=([0-9a-f]{64})$/.exec(request.headers.get(signatureHeader) ?? "")?.[1];
  if (!hex) throw new Error("The webhook signature is invalid");
  const signature = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  // `verify` compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature,
    encoder.encode(`${timestamp}.${body}`),
  );
  if (!valid) throw new Error("The webhook signature is invalid");
  return JSON.parse(body) as { type: string; data: unknown };
}

/** The hooks a Host passes to `createBotSdk`: each finished Run is sent to `url`. */
export function chatWebhookHooks(options: { url: string; secret: string }) {
  return {
    onRunEnd: (run) => sendWebhook({ ...options, type: "run.ended", data: run }),
  } satisfies EventHooks;
}
```

The payload is the hook's payload: ids, the ending, the Model and flags. It never carries Message text, a title or an Attachment name, so a receiver learns what happened and nothing a user typed. Add the other hooks the same way (`onConversationDeleted`, `onSharedLinkChanged`, and so on), each with its own `type`. Your endpoint answers 401 when `receiveWebhook` throws, and otherwise routes the event by its `type`.

User-configured webhooks, where a user enters a URL in settings, are out of scope (ADR 0017 and ADR 0018).

## Several processes: `redisRuntime()`

A Run is shared between the processes of your app through its `runtime`. The default, `memoryRuntime()`, keeps Runs in one process's memory, which is fine for local development and for a Host that runs as a single process.

**Use `redisRuntime()` when more than one process can serve chat requests, including the overlap of a zero-downtime deploy.** Without it, a reader who reconnects to the other process loses the Run, and a Stop sent there does nothing.

```ts
const chat = createBotSdk({
  databaseUrl,
  getUser,
  keyEncryptionSecrets,
  basePath: "/api/chat",
  runtime: redisRuntime({ url: process.env.REDIS_URL! }),
});
```

- `url`: a `redis://` URL (or `rediss://`). Required.
- `prefix`: prepended to every key and channel the SDK writes. Default `chat:`. Set it when the SDK shares a Redis with your own data.

Nothing connects when you build `createBotSdk` or `redisRuntime()`. The first use opens one command connection and one subscriber connection for the process, and `stop()` closes them after the drain, so the process exits cleanly on SIGTERM.

Redis holds each Run's chunk log while the Run is live and for an hour after it ends. Postgres stays the source of truth for Conversations and Messages.

## Rotating the key encryption secret

Stored Provider and Tool credentials are encrypted under `keyEncryptionSecrets`: the first secret encrypts, and every secret decrypts (ADR 0010). Rotate on an event, such as a suspected leak or someone with access leaving, not on a schedule. Rotating is a runbook, not an outage:

1. Put the new secret first in `keyEncryptionSecrets` (in `apps/web`, `KEY_ENCRYPTION_SECRET` becomes the new one and the old one moves to `KEY_ENCRYPTION_SECRET_PREVIOUS`), and deploy. Every process must hold the new keyring before the next step.
2. Run `await chat.rotateKeys()` once, as a one-off command from your image (in `apps/web`: `node scripts/rotate-keys.ts`). Never run it in the pre-deploy step: the old version still running writes under the old key until the deploy finishes. It works in batches and is safe to re-run. It returns `{ reencrypted, unreadable }`.
3. If `unreadable` is 0, remove the old secret and deploy again. If it isn't, find the rows under a key you no longer hold before removing it: a row under a removed key reads as missing, so its user re-enters the credential.

`start()` never refuses to boot because rows are unreadable; it logs the counts instead.

## Who pays for Runs

These options go to the `models` plugin, `models({ hostProviders, byok, defaultBackgroundModel, defaultImageModel, getQuota })`. It also answers an Admin's spend questions: `chat.plugin("models").usage({ userId, since, until })`, `.usageTotals({ since, until })` and `.quota(userId)`.

- `hostProviders` are the Host's own credentials, from your environment (never stored): `[{ provider, credentials, models: [...] }]`. Each model is `{ modelId, label?, images?, pdfs?, tools?, maxOutputTokens, inputUsdPerMillion, outputUsdPerMillion }`. `maxOutputTokens` is required: the Host's output cap for a Run on that model, handed to `adapterFor` (the production adapters don't apply it yet). The prices are per 1M tokens and kept with the model. Capability flags default to off unless the model is curated, in which case its curated flags apply. A Tool goes in the same list as `{ tool: "tavily", credentials, pricePerSearchUsd }`: a Host Tavily key that searches for users with no Tavily key of their own, each search recorded at that fixed price.
- `defaultBackgroundModel` (optional) is a `"provider:model"` id of one of your `hostProviders` Models. Titles use it for users who pick no Background Model; without it they use the Model that wrote the reply. `start()` throws when it isn't one of your Models.
- `defaultImageModel` (optional) is a `"provider:model"` id of one of your `hostProviders` `imageModels`. Generated images use it for users who pick no Image Model; without it they get no Host images. `start()` throws when it isn't one of your Image Models, or when an Image Model has no `pricePerImageUsd`.
- `hostProviders[].embeddingModels` (optional, OpenAI and Gemini only) are the embedding Models Knowledge may use on your credentials: `[{ model, pricePerMillionTokensUsd }]`, with `model` one of `text-embedding-3-small`, `text-embedding-3-large` or `gemini-embedding-001`. Each embedding call on them is recorded as a `usage` row of kind `embedding`, and `start()` throws for any other Provider or Model.
- `byok` (default `true`) lets users run on their own Provider credentials. Set it independently of `hostProviders`: `byok: false` with `hostProviders` is a company Host that runs only its own keys.
- A user's own key for a Provider always wins over the Host's. The Model list marks the Models that run on Host credentials.
- `start()` throws with neither `hostProviders` nor `byok`.
- `getQuota` caps what each user may spend on Host credentials. It is a function `(userId) => { budgetUsd, window: 'day' | 'month' } | null`, or one fixed Quota for everyone. `null` (or leaving it out) is unlimited. Windows are fixed UTC days or calendar months. Spend is measured in money from each Run's cost (the Provider's reported cost, else tokens times the model's price). A Run on Host credentials is refused with HTTP 402 and `code: "quota_exceeded"`, plus `resetsAt`, once the window's spend reaches the budget. A Run that has started finishes, so it can go over the budget by one Run's cost. A user's own key is never checked. Users read their Quota as a percentage, the window and its reset time through the `quota.read` procedure, never as money. The composer shows a meter from 80%, and at the limit the Host Models are disabled with the reset time. A Host can render its own content there with `<AppShell quotaExceeded={...}>`.

```ts
const chat = createBotSdk({
  // ...
  plugins: [
    models({ getQuota: async (userId) => ({ budgetUsd: 0.5, window: "day" }) }),
    runner(),
    assistant(),
  ],
});
```

Three modes, chosen by those two options:

- **Host only** (`hostProviders`, `byok: false`): a company Host. Users chat on the Models you offer. With `byok` off, the credential sections of the keys page and every "add your key" prompt are hidden; the Instructions and Background Model sections stay. Saving a credential is rejected with `FORBIDDEN`; listing and deleting the credentials a user already has still work.
- **User keys only** (no `hostProviders`, `byok: true`): every reply runs on the user's own keys, as before.
- **Both** (`hostProviders` and `byok: true`, the default): a user's own key wins for its Provider; otherwise the Host's Models answer.

```ts
const chat = createBotSdk({
  databaseUrl,
  getUser,
  keyEncryptionSecrets,
  basePath: "/api/chat",
  plugins: [
    models({
      hostProviders: [
        {
          provider: "anthropic",
          credentials: { apiKey: process.env.ANTHROPIC_API_KEY! },
          models: [
            {
              modelId: "claude-haiku-4-5",
              maxOutputTokens: 1024,
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 5,
            },
          ],
        },
      ],
      byok: true,
    }),
    runner(),
    assistant(),
  ],
});
```

## The Host's tools

`tools` lets the Model call your own code on your server. Write each tool with TanStack AI's `toolDefinition(...).server(fn)` and pass the list to `assistant({ tools })`. `fn` gets the call's arguments, and `context.context` holds `{ userId, conversationId }`, typed by passing `HostToolContext` to `.server<HostToolContext>(...)`. Every call shows in the reply as one collapsible row, and a Shared link shows only that the tool was used, never its arguments or result. A tool that throws fails only its own call. A reply makes at most 10 tool calls across the Host's tools. A tool's name must not be `web_search` or `fetch_url`, the SDK's own web tools.

## The Web toggle

The composer's **Web** toggle covers two built-in tools: `web_search` (needs a Tavily key, the user's own or the Host's) and `fetch_url`, which reads one page at an http or https URL the user gave or a search returned. `fetch_url` needs no key, so without a Tavily key Web means fetch only, and the tooltip says so. The toggle is on by default and remembered per browser. It is unavailable, with the reason in its tooltip, when the Model has no tools. A fetched page is a Source, numbered with the search results and cited the same way.

`fetch_url` takes HTML, plain text, Markdown and JSON (no PDFs or other binaries), refuses a body over 2 MB, cuts text to 20,000 characters, times out after 10 seconds, and makes at most 5 fetches per reply. It goes through `deps.fetch`, the guarded fetch, and ignores robots.txt.

```ts
const serverTime = toolDefinition({
  name: "server_time",
  description: "The current time on the server, in UTC.",
  inputSchema: z.object({}),
}).server<HostToolContext>(() => ({ now: new Date().toISOString() }));

createBotSdk({ /* ... */ plugins: [models(), runner(), assistant({ tools: [serverTime] })] });
```

A tool that sets `needsApproval: true` in its `toolDefinition` asks the user first. The reply ends at the call and shows the tool's name, its full arguments, and Approve and Deny. Approving runs the tool; denying never runs it, and the Model is told the user declined. The reply then continues in a new Run on the same Message, so the wait takes no server process and survives a restart. While a call waits, the composer waits too, and Stop counts as Deny. A Shared link shows a waiting call as waiting, without its arguments.

```ts
const sendMail = toolDefinition({
  name: "send_mail",
  description: "Sends an email for the user.",
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  needsApproval: true,
}).server<HostToolContext>(async (args) => sendEmail(args));
```

To give a tool its own look in the chat, edit `plugins/assistant/ui/chat/tool-call-row.tsx` in your copy: the copy never overwrites a `ui/` folder.

## Connections to MCP servers

`mcpServers` lists remote MCP servers your users may sign in to: `assistant({ mcpServers: [{ key, name, url, oauth: { clientId, clientSecret } }] })`. Only Streamable HTTP servers on HTTPS are accepted; a `url` that isn't HTTPS throws when `createBotSdk` runs. `key` names the server in storage (letters, digits, `_` and `-`). Register your OAuth client with each server ahead of time: the SDK doesn't use Dynamic Client Registration.

Register this redirect URI with each server, with your app's origin in place of the host: `https://<your-app>/<basePath>/mcp/callback`, for example `https://app.example/api/chat/mcp/callback`. The SDK serves the sign-in start (`<basePath>/mcp/connect`) and this callback through the same handler, so the Host mounts no new route.

With no `mcpServers`, the keys page shows no Connections section and connecting is refused. A user's Connection is stored encrypted under the keyring (ADR 0010). A Connection whose tokens no longer decrypt shows as "Reconnect needed". `deleteUser` removes the user's Connections. Discovery and token requests go through the guarded `fetch`.

## Rate limits

Run starts are limited per user, and the counters live in the `runtime`, so the limit holds across every process that shares it. The default is 20 Run starts a minute. A Run start over the limit answers 429 with `Retry-After` (in seconds), and the chat UI tells the user to try again in a moment.

Override a limit in `createBotSdk`. Each limit is optional, and `false` turns it off:

```ts
const chat = createBotSdk({
  // ...
  rateLimits: { runStart: { limit: 30, windowSeconds: 60 } },
});
```

Shared link views are limited per client IP: 60 a minute by default, answering 429 with `Retry-After`. The SDK does not read forwarded headers itself. Your Host gives the IP through the `getClientIp(request)` option, returning the address your own proxy sets (in a header your proxy overwrites, so a client can't send it). Without the option there are no per-IP limits, only the per-user ones:

```ts
const chat = createBotSdk({
  // ...
  getClientIp: (request) => request.headers.get("x-real-ip"), // only if your proxy sets it
});
```

The server-side `chat.plugin("assistant").getSharedConversation(token)` is not limited: it is your own server-rendered page, and it has no request.

The other limits are per user: Run starts, Attachment uploads, credential saves and checks, and Conversation search. Sign-up, sign-in and password reset stay with your own auth.

Browser side: create a headless client and wrap your chat pages in the provider.

```tsx
const client = createBotSdkClient({
  baseUrl: "/api/chat",
  plugins: [modelsClient(), assistantClient()],
});

<ChatProvider client={client} router={router}>
  {children}
</ChatProvider>;
```

The `router` adapter maps the chat pages (`new`, `conversation`, `keys`) to your URLs. It provides `Link`, `navigate(page)`, `useLocation()` and `shareUrl(token)`. Pass your own TanStack Query client as `queryClient` if you have one; otherwise the provider creates its own.

### Text and locale

The dictionary, `messages`, covers the words the SDK shows for relative times, the Conversation list's date groups and the labels that are listed in the SDK's dictionary (`core/shared/i18n`). Other text is still English and moves into the dictionary over time. Dates, times and numbers are formatted in `locale`. Both are optional and English (`"en"`) is the default.

```tsx
import { type Messages } from "@ai-chat/bot-sdk/core/client";

const messages: Partial<Messages> = {
  "time.today": "Heute",
  "time.minutesAgo": ({ count }) => `vor ${count} Min.`,
};

<ChatProvider client={client} router={router} messages={messages} locale="de">
  {children}
</ChatProvider>;
```

- Keys are the English dictionary's keys (`en` in `core/shared/i18n`, exported from `@ai-chat/bot-sdk/core/client` with the `Messages` type). Your editor checks them, so a misspelt key is an error.
- A value is a string, or a function of its params. Use `Intl.PluralRules` inside the function for plural forms; there is no i18n library.
- A key you leave out falls back to English, so a partial dictionary works.
- The dictionary lives in the SDK, so it survives copying a new version of the SDK in: translate once, pass it in.
- Build `messages` once, outside render (a module-level constant). A new object on every render gives the provider a new value and re-renders the chat UI.
- An unknown key shows as itself.
- `useI18n()` gives a component `{ t, locale }`, the same translator the SDK uses.

## Phones and installing

The `ui/` folders are built for phones: safe areas around the top bar, drawer, composer and full-screen surfaces; tap targets at least 44px on small screens; a 16px composer that doesn't zoom on iOS and stays above the keyboard; code blocks and tables that scroll sideways inside the reply; an Artifact that opens full screen; and full-width Approval buttons. Your Host needs a `viewport-fit=cover` viewport meta for the safe-area insets to be non-zero.

The signed-in shell takes an `installPrompt` node for your app's install UI, shown at the bottom of the drawer. `apps/web` fills it with a row that offers Install on Chromium and the Share steps on iOS, and goes once installed or dismissed:

```tsx
<AppShell userMenu={<UserMenu />} installPrompt={<InstallPrompt />}>
  {children}
</AppShell>
```

If your Host has a service worker (for an installable app, or for offline pages), it must never intercept `${basePath}/*` (the chat's API, MCP callback and export routes) or `/share/*` (Shared links). Those answers must always come from the server, never from a cache. The `apps/web` worker (`public/sw.js`) skips both, and a Host's worker should do the same.
