# Bot SDK

Bots a Host copies into its own source tree: each user's Bots, with their Turns, Routines, Helpers, Memory, Skills, Knowledge, Computer and email (ADR 0027). The SDK is one folder with these parts:

- `core/` (`shared`, `server`, `client`, including `client/react`): runtime code the Host never edits. Updating means copying it again.
- `plugins/<name>/` (`models`, `runner`, `bot`, `memory`, `skills`, `knowledge`, `computer`, `channel`, `mcp`): each plugin's `shared`, `server` and `client` are runtime code like `core/`; its `ui/` is the Host's.
- `ui/` (the SDK's `theme.css` and `settings/export-data-button.tsx`), and each plugin's `ui/`: React components the Host owns and may change. They sit on the Host's own shadcn primitives.
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
- copies each `ui/` folder (the root one and each plugin's) only when that folder is missing at the destination, checked folder by folder, so your edits to components and `theme.css` survive updates;
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

Your imports then read exactly like this repo's: `@ai-chat/bot-sdk/core/server`, `@ai-chat/bot-sdk/plugins/models/server`, `@ai-chat/bot-sdk/plugins/bot/ui`, and so on.

### Updating

1. Run the copy script again. `VERSION` shows the commit you now run.
2. Your `ui/` folders are untouched. If the release changed a component you also edited, merge that by hand: diff the new SDK's `ui/` folders against yours. A copy from before the Bot-only SDK (ADR 0027) still holds the assistant's folders: delete `plugins/assistant/` and any `ui/chat/`, `ui/shell/`, `ui/pages/` and `ui/settings/` left in your root `ui/`, and drop `@source "../plugins/assistant/ui";` from your `theme.css`. A `theme.css` copied before this release also lacks `@source "../plugins/knowledge/ui";` and `@source "../plugins/skills/ui";`: add them, or the Knowledge and Skills screens lose their styles.
3. Install any new dependencies listed below, then run your type check.

## Dependencies

Install these in the Host. There is one `package.json` for the whole SDK, and versions come from it. The copy script copies every plugin, so a Host installs every group below.

**What `core/` needs:**

- `@tanstack/ai`
- `@tanstack/react-query`, `react`, `sonner`
- `drizzle-orm` and `pg` (the Postgres driver it uses)
- `redis` (the Redis client, used by `redisRuntime()`)
- `undici` and `ipaddr.js`, for the SSRF-guarded `fetch` (`core/server/lib/guarded-fetch.ts`). `undici` pins each connection to the address that was checked, and `ipaddr.js` classifies that address. Install `undici` at the major your Node bundles (7.x on Node 24): undici 8's dispatcher is rejected by Node's built-in `fetch`.
- `aws4fetch`, which signs requests for `s3BlobStore`
- `@orpc/client`, `@orpc/contract`, `@orpc/server`, `@orpc/tanstack-query`
- `zod`

**What the `models` plugin needs (on top of `core/`):**

- the provider packages: `@tanstack/ai-anthropic`, `@tanstack/ai-bedrock`, `@tanstack/ai-byteplus`, `@tanstack/ai-cloudflare`, `@tanstack/ai-gemini`, `@tanstack/ai-grok`, `@tanstack/ai-groq`, `@tanstack/ai-llmgateway`, `@tanstack/ai-lovable`, `@tanstack/ai-mistral`, `@tanstack/ai-ollama`, `@tanstack/ai-openai`, `@tanstack/ai-openrouter`, `@tanstack/ai-vercel-gateway`
- for its `ui/`: `lucide-react`

**What the `bot` plugin needs (on top of `core/`):**

- `playwright-core` (pinned at 1.63.0), which drives the Computer's browser over CDP; `react-dom` for its `ui/`
- for its `ui/`: `lucide-react`

**What the `mcp` plugin needs (on top of `core/`):**

- `@tanstack/ai-mcp`, pinned at 0.8.1 (the release whose `@tanstack/ai` range matches), the MCP client. The sign-in itself is the SDK's own: the library exports no OAuth helpers. It brings `@modelcontextprotocol/*` and `jose`.

**What the `knowledge` plugin needs (on top of `core/`):**

- for converting uploaded files to text: `cheerio`, `htmlparser2`, `csv-parse`, `mammoth`, `pdfjs-dist`, `@thednp/dommatrix`
- for its `ui/`: `lucide-react`

**What the `computer` plugin needs (on top of `core/`):**

- `e2b` (pinned at 2.55.0), the E2B JS SDK. Only `plugins/computer/e2b` imports it, so a Host that does not use that subpath can leave it out.

**What the `channel` plugin needs (on top of `core/`):**

- `email-reply-parser` (pinned at 2.3.9), which strips the quoted history from an inbound email so the Bot reads only the new text.

The `runner` and `memory` plugins and the `skills` feature need nothing beyond `core/` (and `lucide-react` for the `ui/` folders).

`core/` is not self-contained: `core/server`, `core/http` and `core/client` import the `plugins/` they compose (the Bot core, Models, Runner, Computer and Channel, and the features' parts), so a Host outside this repo copies `core/` together with `plugins/`.

## shadcn components

`ui/` and each plugin's `ui/` import these from the Host's `@/components/ui/*` (and `@/lib/utils` for `cn`). Add them with the shadcn CLI, which also installs each component's own dependencies:

- `button`, `card`, `dialog`, `input`, `label`, `popover`, `select`, `textarea`, `attachment`

## Tailwind v4

`ui/` and each plugin's `ui/` use Tailwind v4 classes. In your global stylesheet, import Tailwind and then the SDK's `theme.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "./lib/bot-sdk/ui/theme.css";
```

`theme.css` starts with `@source` lines (`@source "../plugins/<name>/ui";` for each plugin with screens), which tell Tailwind to scan those folders wherever the copy sits. Your shadcn theme variables (`--background`, `--primary`, and so on) must also be defined in your stylesheet.

## Postgres

- The database needs the `pg_trgm` extension. `chat.migrate()` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` before its migrations and fails naming it, so a role allowed to create extensions (or a database that already has it) is needed.
- The `database` slot takes `postgres({ connectionString })`, and the SDK opens its own pool on first use, or `postgres({ pool })` with your own node-postgres-compatible pool (`pg`, or a Neon serverless `Pool`), which the SDK queries through and never ends.
- The SDK's tables live in the `chat` schema of the Host's database, not in your ORM's schema. Your ORM's migrations never touch them.
- The SDK's migrations are expand-then-contract: they add tables, columns and indexes, and never drop or rename one in the same release. The version still running during a deploy keeps working against the migrated schema.

## File storage: `blobs`

File bytes go to a `BlobStore`, which `createBotSdk({ blobs })` takes: the files a user sends their Bot and the files a Bot sends back. Names, types, sizes and owners stay in Postgres either way. The store holds bytes only, under keys the SDK makes up, such as `bot-file/<id>`.

- **`postgresBlobStore()`** is the default: bytes in the `chat.blob` table of your database. Leave `blobs` out and nothing changes.
- **`s3BlobStore({ endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle? })`** keeps bytes in any S3-compatible bucket, such as Cloudflare R2 (`region: "auto"`) or RustFS. It needs an existing bucket: the store never creates one, so the app needs no bucket-admin rights. It is built on `aws4fetch`, and `forcePathStyle` defaults to `true`.

```ts
import { createBotSdk, postgres, s3BlobStore } from "@ai-chat/bot-sdk/core/server";

const chat = createBotSdk({
  database: postgres({ connectionString: databaseUrl }),
  keyEncryptionSecrets,
  models: {},
  blobs: s3BlobStore({
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    region: "auto",
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  }),
});
```

- A failed upload leaves no object behind. Deleting a user, and the 24-hour cleanup of uploads no Message sent, remove their objects after the database commit. A failed object delete is logged and not thrown, so a stray object costs storage but no data, and nothing sweeps it.
- **Switching a running deployment from one store to the other isn't supported**: there is no copy tool, so the files already uploaded stay in the store they went to. Choose the store before you go live.

## Host lifecycle

```ts
// server: construct at module load (no side effects)
// the Model options (Host Providers, BYOK, Quota, ...) go to the `models` slot, MCP servers to
// `mcp(...)`, a background jobs runner to the `runner` slot, and the Computer's provider to the
// `computer` slot
const chat = createBotSdk({
  database: postgres({ connectionString: databaseUrl }),
  keyEncryptionSecrets,
  computer: e2bProvider({ apiKey, apiUrl, sandboxUrl, template }),
  models: {},
  features: [memory(), skills(), knowledge(), mcp({ servers })],
  // what the SDK asks you about a user: a banned owner's Routine fires, Check-in fires, Routine
  // webhooks and inbound email start no Turns (in-process calls are trusted)
  users: { isBlocked: (userId) => isBanned(userId) },
});

// the optional HTTP layer (`@ai-chat/bot-sdk/core/http`): one catch-all route on your framework,
// for every chat call; sign-in and the 401 are yours through `getUser`
export const handler = createHttpHandler(chat, { basePath: "/api/chat", getUser });
// on a Node server instead, ahead of any body parser: app.use("/api/chat", toNodeHandler(handler))
// the live view's socket, crossws hooks for <basePath>/screens/<token>/websockify (on Nitro,
// `defineWebSocketHandler(screenSocket)` at that path); webhooks, inbound email, the live view's
// pages and MCP OAuth callbacks are routes of the handler above
export const screenSocket = createScreenSocket(chat, { basePath: "/api/chat" });

// deploy step, once per deploy
await chat.migrate();

// boot and shutdown
await chat.start();
// the runner drains its jobs for up to 250 s; a SIGTERM listener stops Node from exiting by itself
process.on("SIGTERM", () => void chat.stop().finally(() => process.exit(0)));

// when your app deletes a user
await chat.users.delete({ userId: String(user.id) });

// when your app exports a user's data: one JSON-ready document (version 2), never credentials; each plugin's part sits under its plugin id (`copy.bot`, `copy.memory`)
const copy = await chat.users.export({ userId: String(user.id) });

// when your app bans a user: their running Turns, Helpers and Demonstrations stop
await chat.bots.stopTurns({ userId: String(user.id) });
```

On the client, build a headless client from the core's contract and your features' client parts, and wrap your pages in the provider:

```tsx
const client = createBotSdkClient({
  baseUrl: "/api/chat",
  features: [memoryClient(), skillsClient(), knowledgeClient(), mcpClient(), channelClient()],
});

<ChatProvider client={client} router={router}>
  {children}
</ChatProvider>;
```

- `getUser(request)` returns `{ id } | null`. The HTTP handler answers 401 when it returns `null`. The core never sees a request: its own methods (`chat.bots.send({ userId, ... })`) take the user's id.
- `reviewModel` (optional) is the Model that Auto-reviews each Bot's risky tool calls before they run, a `"provider:model"` id from the Models' list, resolved per user: `createBotSdk({ reviewModel: "openai:gpt-5.4-mini" })`. Unset, or one the user can't use, the Bot's own Model reviews, in a fresh context.
- The client is typed by contracts alone (spec #873): the core's (`coreContract` in `core/client`) and each feature's (`plugins/<name>/shared/contract.ts`), so no server code reaches the browser bundle, not even a type. It mirrors the instance: `client.rpc.bots.send` is `sdk.bots.send`, and a feature's procedures are under its id (`client.rpc.memory.status`). One link carries them all.
- The `router` adapter maps the SDK's pages (`keys`, and `bots` with an optional Bot `id`) to your URLs. It provides `Link` and `navigate(page)`. Pass your own TanStack Query client as `queryClient` if you have one; otherwise the provider creates its own.
- The Bots app is `BotsApp` from `plugins/bot/ui`, with the Host's account menu at the foot of its sidebar (`accountMenu`); the keys page is `KeySettingsPage` from `plugins/models/ui`.
- `GET <basePath>/export` answers the signed-in user's export as a JSON download (`chat-export-<date>.json`), the same document as `users.export`. The `ExportDataButton` in `ui/settings/export-data-button.tsx` calls it.
- `start()` refuses to run while the `chat` schema is behind the bundled migrations.
- `stop()` stops the plugins (the runner takes no new jobs and waits for the running ones), then closes the runtime's connections.

## Background jobs: `runner`

The runner is part of the core: it runs the background work (ADR 0011), Bot Turns, Routines, Check-ins and Memory passes. A Host lists nothing for it.

The `runner` slot (`createBotSdk({ runner })`) takes the runner for background work. The default is the in-process runner: it keeps jobs in the `chat.job` table, which the `chat` schema already has, polls it every 2 s, runs two jobs at once and retries a failed job up to three times, after about 10 s and 1 min. `start()` starts it, and `stop()` takes no new jobs and waits for the running ones. Nothing else to configure, and no second database.

A custom runner is any object with `enqueue(name, payload, options?)`, `start()` and `stop()`, and it takes the place of the default.

A Host runs its own background work on the same runner. `defineJob({ name, payload, run, onFailed?, onCancelled?, concurrency? })` defines a job, and the factory's `jobs` option lists it (`createBotSdk({ jobs: [myJob] })`); a feature lists its own in its `jobs`. Nothing else knows a job: one no instance lists can't be queued, and two jobs with one name throw at construction. `run(payload, ctx)` gets durable steps (`ctx.step(name, (tx) => …)`: `fn` gets the transaction that saves the step's Checkpoint, so its writes commit with it), `ctx.now()`, `ctx.random()`, `ctx.patched(id)`, `ctx.signal`, and the core services (`ctx.db`, `ctx.jobs`, …; a feature's job gets the services its `needs` name). `sdk.runner.enqueueIn(tx, …)` and `sdk.runner.cancelIn(tx, …)` queue and cancel a job in the Host's own transaction. In a transaction of the SDK's database (`ctx.db` in a job or a feature), `enqueueIn` and `replaceIfNotStarted` notify the Executor once it commits; in one of the Host's own Drizzle instance on the same Postgres, the job is written the same way but nothing is notified, and the in-process runner's poll picks it up at its next poll (every 2 s by default). A runner whose Executor doesn't poll needs the SDK's transaction. A job with `concurrency` runs at most that many at once on the in-process runner, beside the shared budget of two.

## Memory: `memory`

The `memory` feature keeps each Bot's file memory (ADR 0022), its post-turn pass, the `search_memory` tool and the user's Memory switch. A Host turns it on in `features`: `features: [memory()]`, with `memoryClient()` on the client. It needs a Computer, where the files live: `createBotSdk` throws at construction when the `computer` slot is empty. It's imported from `@ai-chat/bot-sdk/plugins/memory/server` (and `/client`, `/ui`). A Host turns Memory off by leaving it out: Bots then keep no Memory, and the keys page shows no Memory section.

The `skills` feature (each Bot's `SKILL.md` files, spec #713) and the `knowledge` feature (a user's Knowledge as plain files, spec #737), both listed in `features`, keep their files on the user's Computer, so they need `computer`. Without it, `createBotSdk` throws for `skills()` and `knowledge()`.

## A Computer for Bots: `computer`

The Computer is part of the core: it gives each user one Computer, a real machine where their Bots run shell commands and keep files. Leave the `computer` slot unset and Bots run without a Computer: no tools, and no mention of them in the system prompt.

The slot takes a provider. The E2B provider is on its own subpath, so a Host that never imports it never loads the `e2b` package:

```ts
import { e2bProvider } from "@ai-chat/bot-sdk/plugins/computer/e2b";

createBotSdk({
  // ...
  computer: e2bProvider({ apiKey, apiUrl, sandboxUrl, template: "ai-chat-computer-v3" }),
});
```

`apps/web` sets the `computer` slot only when `E2B_API_KEY`, `E2B_API_URL` and `E2B_SANDBOX_URL` are all set.

A user's Computer is created on their first operation, and with `bot` on, only for a user who has a Bot: `bot` adds that owner check (`addOwnerCheck`), so a Turn that races its user's delete leaves no Computer behind. A plugin that uses the Computer for users without a Bot adds its own check.

### The template

`plugins/computer/template/Dockerfile` is a Debian image with Screens: Xvfb, x11vnc, noVNC (websockify), xdotool, scrot and Chromium, plus the `ai-chat-screen` start script that `openScreen`, `closeScreen` and `setScreenControl` run. A Computer without Screens only needs `/home/user`, `bash` and `tar`, so a Host that never opens a Screen can pass any template with those. The template's name is its version: change the name with every change to the Dockerfile, and every Computer is rebuilt on its next wake. `apps/web` keeps the name in `computerTemplate` (`src/services.ts`).

Build it into self-hosted E2B with the E2B CLI (no dependency is added; `pnpm dlx` fetches it), from `packages/bot-sdk`, with the three variables above in the environment:

```sh
pnpm dlx @e2b/cli@2.22.0 template create ai-chat-computer-v3 --memory-mb 1536 -p plugins/computer/template -d Dockerfile
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
- `ai-chat-computer-v3` needs that bigger disk too: its packages leave about 1.3 GiB free on the 2.8 GiB root, against about 245 MB on the default tier.
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

## Email for Bots: `channels`

The core's Channels (`sdk.channels`) give each Bot its own email address (spec #761, ADR 0026): the owner's mail to it wakes the Bot like a web Message, and the Bot's replies are emailed back. Email is an adapter in the `channels` slot, imported from `@ai-chat/bot-sdk/plugins/channel/server` (and `/client`, `/ui` for the Bot header's Email popover). Leave the slot out and Bots have no address.

```ts
import { emailChannel } from "@ai-chat/bot-sdk/plugins/channel/server";
import { mailpitEmailProvider } from "@ai-chat/bot-sdk/plugins/channel/mailpit";

createBotSdk({
  // …
  channels: [
    emailChannel({
      provider: mailpitEmailProvider({ apiUrl: "http://localhost:8025" }),
      domain: "bots.localhost", // the Bots' addresses are name@<domain>
      appUrl: "http://localhost:3001", // an email's links open <appUrl>/bots/<botId>
    }),
  ],
  // Only mail from the user's verified account email reaches their Bots.
  users: { verifiedEmail: async (userId) => (await readVerifiedEmail(userId)) ?? null },
});
```

The HTTP layer (`createHttpHandler`) serves the inbound route at `POST <basePath>/channels/email`, with no sign-in; point the provider's webhook there. Without HTTP, hand a mail the provider parsed to `sdk.channels.receive("email", mail)`. The route answers 202 to any mail the provider can read, whether it woke the Bot or was dropped, and 400 to one it can't, so a sender learns nothing.

A mail is a Trigger only when it is from the user's verified email, is addressed to a Bot's address, carries a DMARC pass, and is not a Bot's own or an automatic reply; the Quota and the Ban apply as for a webhook. The Bot reads the new text only (quoted history is stripped), the subject as a first line unless the mail replies to the Bot's thread, one line naming the attachments (they aren't kept), and anything forwarded in an untrusted fenced block that Auto-review never takes as permission.

A provider is the seam to a mail service (`EmailProvider`: `parseInbound` and `send`). Two ship:

- `plugins/channel/mailpit`: a local Mailpit. Its received-message webhook POSTs to the inbound route, and the provider fetches that mail from Mailpit's REST API, so it refuses a webhook for a message Mailpit doesn't hold. Mailpit gives no SPF, DKIM or DMARC verdict, so the provider vouches for every mail it holds: use it only on a Host that listens on localhost.
- `plugins/channel/fake`: for tests and evals. An inbound request's body is the mail as JSON, with its own `authentication`, and each sent mail is kept in `sent`. It vouches for whatever it is sent, so never mount it on a route others can reach.

## Keeping a Bot's thread in sync: `conversations.changes`

Every change to a Bot's thread (a Message, a Turn starting or ending, a Secret, Routine, review, Helper, Check-in or Summary) is written to the Conversation's change log in the same transaction, with a sequence number (ADR 0026). `bots.get` returns the thread with its newest number as `lastSeq`, the cursor. `conversations.changes({ conversationId, since })` (the thread's `conversationId` from `bots.get`) returns the changes after the cursor, oldest first, each with what it points at as it is now, or `{ reload: true }` when the log (the newest 500 per Conversation) no longer holds them all, so the thread must be read afresh with `bots.get`.

The server's only live signal is the data-less `{ "type": "changed" }` hint on the SSE `/events` route; a Bot app never takes data from it. A tab fetches the changes on a hint, when the stream (re)connects, when the window gets focus back and, while a Turn runs, every 30 seconds. `useBotSync` does this for the Bot components; a Host with its own UI calls `conversations.changes` the same way and applies the changes in order.

## Calling the SDK from the Host's own server code

Every Bot operation is also a domain method on the instance, grouped by namespace (spec #873). Each takes one object with the user's id and no request; the RPC procedures are wrappers that pass the signed-in user's id. A method refuses another user's data as its procedure does, and in-process calls are not rate-limited.

```ts
const bot = await sdk.bots.create({ userId, name: "Ada", model: "openai:gpt-6-luna" });
await sdk.bots.send({ userId, botId: bot.id, id: uuidv7(), text: "Hi" });

const { conversationId, lastSeq } = await sdk.bots.get({ userId, botId: bot.id });
const hints = await sdk.conversations.watch({ userId, conversationId, signal });
let since = lastSeq;
const sync = async () => {
  const result = await sdk.conversations.changes({ userId, conversationId, since });
  // Apply the changes and move `since` to the last one's seq, or read the thread afresh on `reload`.
};
// Once now, for what changed before the subscription, then on each hint.
await sync();
for await (const _hint of hints) await sync();
```

`sdk.bots` has `create`, `list`, `get`, `send`, `upload`, `stop`, `warm`, `choose` and `react`. `sdk.secrets` has `save`, `list` and `delete`; a value never comes out. `sdk.computer` has `view` and `control` for a Helper's Screen (the instance's `computer` holds these only, not the Computer provider the features get). `sdk.models` has `list`, `imageModel`, `setImageModel` and `credentials` (`list`, `openaiState`, `save`, `delete`) beside its metering, `usage` and Quota reads. `sdk.conversations.watch` resolves once its subscription is in place, so `changes` read after it misses nothing; it ends when `signal` aborts or the loop stops. Pass a `signal` unless you always iterate the hints.

Each enabled feature's methods are `sdk.<feature id>`, typed from the `features` you pass, and absent when the feature is off: `sdk.memory` (`status`, `isEnabled`, `setEnabled`, `botList`, `botAddLine`, `botEditLine`, `botDeleteLine`, `botReadFile`, `botSaveFile`), `sdk.skills` (`status`, `list`, `read`, `save`, `remove`), `sdk.knowledge` (`status`, `list`, `read`, `upload`, `uploadDocument`, `remove`, `createFolder`) and `sdk.mcp` (`listConnections`, `disconnect`, `forUser`). A feature you write with `defineFeature` gets its `api` the same way.

A feature serves its methods over HTTP through its `contract` (oRPC's `oc` from `@orpc/contract`), under `<basePath>/rpc/<id>`: each procedure calls the `api` method at the same path with its validated input and the signed-in user's `userId`, and `createBotSdk` throws when the `api` has no method for one. On the client, its part is `{ id, contract, urls? }`, passed in `features`, and its UI reads it through `useOrpc<{ <id>: typeof contract }>()`.

## Host hooks

`createBotSdk({ hooks })` takes the Host's callbacks into the SDK. Every hook is optional.

```ts
const chat = createBotSdk({
  // ...
  logger, // where the SDK's own failures go; defaults to console
  hooks: {
    // every usage row written on Host credentials: a Bot Turn, a Helper, a review, a memory pass,
    // a web search, a generated image, ...
    onUsage: (usage) => {
      // usage: { id, userId, kind, model, inputTokens, outputTokens, cacheReadTokens,
      //   cacheWriteTokens, sourceId, promptHashes, costMicros, estimated, createdAt }
    },
    // a Conversation the core's delete removed, when that delete announces it
    onConversationDeleted: (conversation) => {
      // conversation: { userId, conversationId }
    },
  },
});
```

- **Delivery.** A hook runs after its change is written. It is never awaited, so a slow hook never delays a Turn or a response. It runs at most once, with no retries: design your own delivery if you need one.
- **Failures.** A hook that throws or rejects is logged through the Host's `logger` (`logger.error`).
- **Credentials.** `onUsage` fires only for usage on Host credentials (ADR 0007), never for a call on the user's own credentials.
- **Deleting a user.** `deleteUser` fires no hooks.
- **The SDK's failures.** Failed jobs, usage rows and the database pool go to the Host's `logger`. The Redis runtime's connection errors still go to `console`: `redisRuntime()` takes no logger yet.

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

/** The hooks a Host passes to `createBotSdk`: each usage row on Host credentials is sent to `url`. */
export function chatWebhookHooks(options: { url: string; secret: string }) {
  return {
    onUsage: (usage) => sendWebhook({ ...options, type: "usage.recorded", data: usage }),
  } satisfies EventHooks;
}
```

The payload is the hook's payload: ids, the Model, token counts and cost. It never carries Message text or a file name, so a receiver learns what happened and nothing a user typed. Add `onConversationDeleted` the same way, with its own `type`. Your endpoint answers 401 when `receiveWebhook` throws, and otherwise routes the event by its `type`.

User-configured webhooks, where a user enters a URL in settings, are out of scope (ADR 0017 and ADR 0018).

## Inbound webhooks for Routines

A Bot's Routine can run whenever an outside service calls its secret URL (ADR 0021). The HTTP layer (`createHttpHandler`) serves it at `POST <basePath>/routines/webhook/<token>` with no sign-in, since the token is the authentication. Without HTTP, call the domain method:

```ts
const receipt = await sdk.routines.receiveWebhook({ token, body, headers });
// "accepted" | "notFound" | "payloadTooLarge" | "idempotencyKeyTooLong"
```

The route answers `202` at once, `413` to a body over 64 KB, and `404` to a token that matches no active Routine. With an `Idempotency-Key` header, a retried delivery wakes the Bot once. The token is stored only as a hash, so the app shows a Routine's URL once, after it is approved or rotated.

## Several processes: `redisRuntime()`

The processes of your app share signals (the data-less hints that a Bot's thread changed, ADR 0026) and rate-limit counters through the `pubsub` slot. The default, `memoryRuntime()`, keeps them in one process's memory, which is fine for local development and for a Host that runs as a single process.

**Use `redisRuntime()` when more than one process can serve requests, including the overlap of a zero-downtime deploy.** Without it, a tab connected to the other process misses the hints until it fetches the changes on its own, and each process counts rate limits by itself.

```ts
const chat = createBotSdk({
  database: postgres({ connectionString: databaseUrl }),
  keyEncryptionSecrets,
  models: {},
  pubsub: redisRuntime({ url: process.env.REDIS_URL! }),
});
```

- `url`: a `redis://` URL (or `rediss://`). Required.
- `prefix`: prepended to every key and channel the SDK writes. Default `chat:`. Set it when the SDK shares a Redis with your own data.

Nothing connects when you build `createBotSdk` or `redisRuntime()`. The first use opens one command connection and one subscriber connection for the process, and `stop()` closes them, so the process exits cleanly on SIGTERM. Postgres stays the source of truth.

## Rotating the key encryption secret

Stored Provider and Tool credentials, Bot Secrets and MCP Connection tokens are encrypted under `keyEncryptionSecrets`: the first secret encrypts, and every secret decrypts (ADR 0010). Rotate on an event, such as a suspected leak or someone with access leaving, not on a schedule. Rotating is a runbook, not an outage:

1. Put the new secret first in `keyEncryptionSecrets` (in `apps/web`, `KEY_ENCRYPTION_SECRET` becomes the new one and the old one moves to `KEY_ENCRYPTION_SECRET_PREVIOUS`), and deploy. Every process must hold the new keyring before the next step.
2. Run `await chat.rotateKeys()` once (it re-encrypts what each installed plugin stores: `models`, `bot` and the `mcp` feature), as a one-off command from your image (in `apps/web`: `node scripts/rotate-keys.ts`). Never run it in the pre-deploy step: the old version still running writes under the old key until the deploy finishes. It works in batches and is safe to re-run. It returns `{ reencrypted, unreadable }`.
3. If `unreadable` is 0, remove the old secret and deploy again. If it isn't, find the rows under a key you no longer hold before removing it: a row under a removed key reads as missing, so its user re-enters the credential, Secret or Connection.

`start()` never refuses to boot because rows are unreadable; it logs the counts instead.

## Who pays for Model calls

These options go in the `models` slot, `createBotSdk({ models: { hostProviders, byok, defaultImageModel, getQuota } })`. The core's Models also answer an Admin's spend questions: `chat.models.usage({ userId, since, until })`, `.usageTotals({ since, until })` and `.quota(userId)`.

- `hostProviders` are the Host's own credentials, from your environment (never stored): `[{ provider, credentials, models: [...] }]`. Each model is `{ modelId, label?, images?, pdfs?, tools?, maxOutputTokens, inputUsdPerMillion, outputUsdPerMillion, cacheReadUsdPerMillion?, cacheWriteUsdPerMillion? }`. `maxOutputTokens` is required: the Host's output cap for a call on that model, handed to `adapterFor` (the production adapters don't apply it yet). The prices are per 1M tokens and kept with the model; the cache prices are for input read from and written to the Provider's prompt cache, and are the input price when unset. Capability flags default to off unless the model is curated, in which case its curated flags apply. A Tool goes in the same list as `{ tool: "tavily", credentials, pricePerSearchUsd }`: a Host Tavily key that searches for users with no Tavily key of their own, each search recorded at that fixed price.
- `defaultImageModel` (optional) is a `"provider:model"` id of one of your `hostProviders` `imageModels`. Generated images use it for users who pick no Image Model; without it they get no Host images. `start()` throws when it isn't one of your Image Models, or when an Image Model has no `pricePerImageUsd`.
- `byok` (default `true`) lets users run on their own Provider credentials. Set it independently of `hostProviders`: `byok: false` with `hostProviders` is a company Host that runs only its own keys.
- A user's own key for a Provider always wins over the Host's. The Model list marks the Models that run on Host credentials.
- `start()` throws with neither `hostProviders` nor `byok`.
- `getQuota` caps what each user may spend on Host credentials. It is a function `(userId) => { budgetUsd, window: 'day' | 'month' } | null`, or one fixed Quota for everyone. `null` (or leaving it out) is unlimited. Windows are fixed UTC days or calendar months. Spend is measured in money from each call's cost (the Provider's reported cost, else tokens times the model's price). A call on Host credentials is refused once the window's spend reaches the budget. A Turn that has started finishes, so it can go over the budget by one Turn's cost. A user's own key is never checked. Users read their Quota as a percentage, the window and its reset time through the `models.readQuota` procedure, never as money. At the limit the Model picker disables the Host Models and shows the reset time.

```ts
const chat = createBotSdk({
  // ...
  models: { getQuota: async (userId) => ({ budgetUsd: 0.5, window: "day" }) },
});
```

Three modes, chosen by those two options:

- **Host only** (`hostProviders`, `byok: false`): a company Host. Users chat on the Models you offer. With `byok` off, the credential sections of the keys page and every "add your key" prompt are hidden; the other sections stay. Saving a credential is rejected with `FORBIDDEN`; listing and deleting the credentials a user already has still work.
- **User keys only** (no `hostProviders`, `byok: true`): every reply runs on the user's own keys, as before.
- **Both** (`hostProviders` and `byok: true`, the default): a user's own key wins for its Provider; otherwise the Host's Models answer.

```ts
const chat = createBotSdk({
  database: postgres({ connectionString: databaseUrl }),
  keyEncryptionSecrets,
  models: {
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
  },
});
```

## Connections to MCP servers

The `mcp` feature (listed in `features`) lists remote MCP servers your users may sign in to: `mcp({ servers: [{ key, name, url, oauth: { clientId, clientSecret } }] })`, with `mcpClient()` on the client and its `ConnectionsSection` on the keys page. It's imported from `@ai-chat/bot-sdk/plugins/mcp/server` (and `/client`, `/ui`). Only Streamable HTTP servers on HTTPS are accepted; a `url` that isn't HTTPS throws when `createBotSdk` runs. `key` names the server in storage (letters, digits, `_` and `-`). Register your OAuth client with each server ahead of time: the SDK doesn't use Dynamic Client Registration.

Register this redirect URI with each server, with your app's origin in place of the host: `https://<your-app>/<basePath>/mcp/callback`, for example `https://app.example/api/chat/mcp/callback`. The SDK serves the sign-in start (`<basePath>/mcp/connect`) and this callback through the same handler, so the Host mounts no new route.

With no `servers`, the keys page shows no Connections section and connecting is refused. A user's Connection is stored encrypted under the keyring (ADR 0010). A Connection whose tokens no longer decrypt shows as "Reconnect needed". `deleteUser` removes the user's Connections. Discovery and token requests go through the guarded `fetch`. `sdk.mcp.forUser(userId).tools({ signal })` gives a user's connected servers' tools, named `<key>_<tool>`, with their clients open until `signal` aborts; it refreshes expired tokens and skips a server that is down. Bots use a user's connected servers' tools as connectors.

## Rate limits

The HTTP handler limits a few actions per user (in-process calls are never limited), and the counters live in the `pubsub` slot's runtime, so a limit holds across every process that shares it. An action over its limit answers 429 with `Retry-After` (in seconds).

- `attachmentUpload`: Knowledge uploads and the files a user sends their Bot, together. Default 30 per 10 minutes.
- `credentialSave`: Provider and Tool credential saves, each of which runs a check. Default 10 a minute.

Override a limit in `createHttpHandler`. Each limit is optional, and `false` turns it off:

```ts
const handler = createHttpHandler(chat, {
  // ...
  rateLimits: { attachmentUpload: { limit: 60, windowSeconds: 600 } },
});
```

Sign-up, sign-in and password reset stay with your own auth.

## Text and locale

The dictionary, `messages`, covers the labels listed in the SDK's dictionary (`core/shared/i18n`). Other text is still English and moves into the dictionary over time. Dates, times and numbers are formatted in `locale`. Both are optional and English (`"en"`) is the default.

```tsx
import { type Messages } from "@ai-chat/bot-sdk/core/client";

const messages: Partial<Messages> = {
  "bots.newBot": "Neuer Bot",
  "bots.todoCount": ({ count }) => `Aufgaben ${count}`,
};

<ChatProvider client={client} router={router} messages={messages} locale="de">
  {children}
</ChatProvider>;
```

- Keys are the English dictionary's keys (`en` in `core/shared/i18n`, exported from `@ai-chat/bot-sdk/core/client` with the `Messages` type). Your editor checks them, so a misspelt key is an error.
- A value is a string, or a function of its params. Use `Intl.PluralRules` inside the function for plural forms; there is no i18n library.
- A key you leave out falls back to English, so a partial dictionary works.
- The dictionary lives in the SDK, so it survives copying a new version of the SDK in: translate once, pass it in.
- Build `messages` once, outside render (a module-level constant). A new object on every render gives the provider a new value and re-renders the UI.
- An unknown key shows as itself.
- `useI18n()` gives a component `{ t, locale }`, the same translator the SDK uses.

## Phones and installing

The `ui/` folders are built for phones: safe areas, and tap targets at least 44px on small screens. Your Host needs a `viewport-fit=cover` viewport meta for the safe-area insets to be non-zero.

`apps/web` puts its install prompt (Install on Chromium, the Share steps on iOS) above the account menu, in `BotsApp`'s `accountMenu`.

If your Host has a service worker (for an installable app, or for offline pages), it must never intercept `${basePath}/*` (the SDK's API, MCP callback and export routes). Those answers must always come from the server, never from a cache.
