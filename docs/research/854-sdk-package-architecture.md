# Research: package architecture of leading TypeScript SDKs

Ticket: [#854](https://github.com/Daanish2003/bot-sdk/issues/854) (child of map [#853](https://github.com/Daanish2003/bot-sdk/issues/853)).
Researched: 2026-10-25, against each repo's `main` branch through the GitHub API (`gh api`), plus official docs pages where noted. Links point at `main` (Payload: branch `3.x`), so line numbers can drift.

## Question

How do leading TypeScript SDKs split their packages and keep a small core extensible? For Mastra, the Vercel AI SDK, Vercel's Chat SDK (`chat`), Better Auth, LangGraph.js, Payload and Inngest, this note covers five things: what packages each ships, how it is extended, how unused features stay free for the Host, how types reach the client, and how it is built and released. It ends with the recurring patterns, compared with our Bot SDK: the `BotSdkPlugin` type in `packages/bot-sdk/core/server/plugin.ts`, the 15.5K-line `bot` plugin, and plugins that call each other through `sdk.plugin("x")`.

## Answer in one paragraph

None of the seven ships one package that holds every feature behind runtime `enabled` flags.

- They all split into a **small core package**, a **separate package per infrastructure adapter**, and **separate packages or subpaths per optional feature**, with the core as a `peerDependency`.
- Only **Better Auth** and **Payload** have a real plugin system that declares tables, routes, hooks and lifecycle, and only those two **compute the database schema from the plugins that are enabled**.
- The other five use **interface adapters plus composition**: you pass objects to a constructor or to `compile()`. They own little or no schema; LangGraph's checkpointers ship their own versioned SQL behind `setup()`.
- **Cross-feature access** is either typed through an augmentable registry (Better Auth `getPlugin`/`hasPlugin` with `BetterAuthPluginRegistry`, Payload `RegisteredPlugins`) or avoided altogether by passing values explicitly (AI SDK, LangGraph, Chat SDK, Inngest).
- **Client types** are inferred from server values, with no codegen, everywhere except Payload (JSON-schema codegen) and Mastra (generated route types, nothing inferred from the user's instance).
- **Build and release**: tsdown is the norm (5 of 7), Changesets is the norm (6 of 7), and ESM-only is the majority (4 of 7).

## Comparison at a glance

| SDK             | Core package                                                                 | Extension mechanism                                                                                  | Owns schema?                                                                   | Features declare routes?                                          | Client types                                                                | Build / format            | Release                                                    |
| --------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| Mastra          | `@mastra/core` (~85 subpaths, large)                                         | One big config object + `__registerMastra` injection; storage adapters implement fixed domains       | Yes, a closed set of 24 domains; every adapter creates all of them on `init()` | `registerApiRoute` + a static route table in `@mastra/server`     | Generated from route Zod schemas; nothing inferred from the user's instance | tsdown, ESM + CJS         | Changesets, `fixed` groups, permanent `alpha` pre mode     |
| Vercel AI SDK   | `ai`, with the spec in `@ai-sdk/provider`                                    | Versioned provider interfaces (`LanguageModelV4`), middleware, `createProviderRegistry`              | No                                                                             | No (the Host writes the route)                                    | Inferred: `InferUITools` → `UIMessage` → `useChat<M>`                       | tsdown, ESM-only          | Changesets, independent versions, snapshots                |
| Vercel Chat SDK | `chat`                                                                       | `new Chat({ adapters, state })`; `Adapter` interface with ~25 optional capabilities; `StateAdapter`  | No; a KV/lock/queue `StateAdapter` only                                        | One webhook per adapter: `chat.webhooks.slack(req)`               | Generics on `Chat<TAdapters, TState>`; the browser uses AI SDK types        | tsup, ESM-only            | Changesets, one `fixed` group (`chat` + `@chat-adapter/*`) |
| Better Auth     | `better-auth`, with types in `@better-auth/core`                             | **`BetterAuthPlugin` object**: `id`, `init`, `endpoints`, `schema`, `hooks`, `rateLimit`, …          | **Yes, merged from the enabled plugins only**                                  | Yes, `endpoints` via `createAuthEndpoint`                         | Inferred: a client plugin's `$InferServerPlugin`                            | tsdown, ESM-only          | Changesets, all 22 packages in one `fixed` group           |
| LangGraph.js    | `@langchain/langgraph`, with interfaces in `@langchain/langgraph-checkpoint` | Abstract adapters (`BaseCheckpointSaver`, `BaseStore`) passed to `compile()`; subgraphs as nodes     | Each adapter ships versioned SQL behind an explicit `setup()`                  | No in the library; the separate Agent Server package has them     | Inferred: `useStream<typeof graph>()`                                       | tsdown wrapper, ESM + CJS | Changesets, independent (fixed for api/cli/ui)             |
| Payload (v3)    | `payload`                                                                    | **Plugin = `(config) => config`**, plus `definePlugin` (experimental) and `db`/`email`/`kv` adapters | **Yes, from the final config; `migrate:create` diffs it**                      | Yes, `endpoints` at the root, per collection or per global        | **Codegen**: `payload generate:types`, with module augmentation             | SWC + tsc, ESM-only       | Custom releaser (no Changesets), lockstep                  |
| Inngest         | `inngest` (adapters on subpaths)                                             | Class middleware with lifecycle hooks; `serve()` framework adapters over `InngestCommHandler`        | No (server-side platform)                                                      | One endpoint (GET/PUT/POST) per app; middleware can add functions | Inferred: middleware `ctx` extensions and `eventType` schemas               | tsdown, ESM + CJS         | Changesets, independent, PR prerelease builds              |

## Findings per SDK

### 1. Mastra (`mastra-ai/mastra`)

**Packages.** A pnpm/turbo monorepo with top-level `packages/ stores/ deployers/ server-adapters/ client-sdks/ auth/ voice/ observability/ pubsub/ workflows/` ([repo](https://github.com/mastra-ai/mastra)).

- **`@mastra/core`** holds agents, workflows, tools, the memory base, the storage base and its domain interfaces, the vector base, server types, `registerApiRoute`, the auth base, voice and observability.
  - It has about 85 `exports` subpaths, each with ESM and CJS builds.
  - It sets `"sideEffects": false` and has `zod` as its only peer.
  - It still carries hard dependencies on `hono`, `posthog-node`, `ws` and `execa` ([package.json](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)).
- **`@mastra/server`** holds framework-neutral route handlers ([package.json](https://github.com/mastra-ai/mastra/blob/main/packages/server/package.json)). The server adapters `@mastra/{hono,express,fastify,koa,elysia,nestjs,next,tanstack-start}` each peer their framework ([server-adapters/](https://github.com/mastra-ai/mastra/tree/main/server-adapters), [hono](https://github.com/mastra-ai/mastra/blob/main/server-adapters/hono/package.json)).
- **Storage and vector adapters** are one package each, about 30 of them: pg, libsql, mongodb, dynamodb, upstash, pinecone, qdrant and others ([stores/](https://github.com/mastra-ai/mastra/tree/main/stores)). Each peers `@mastra/core` and depends on its own driver ([pg](https://github.com/mastra-ai/mastra/blob/main/stores/pg/package.json)).
- **Other families** are also one package each: auth providers ([auth/](https://github.com/mastra-ai/mastra/tree/main/auth)), voice ([voice/](https://github.com/mastra-ai/mastra/tree/main/voice)), observability exporters ([observability/](https://github.com/mastra-ai/mastra/tree/main/observability)), pubsub ([pubsub/](https://github.com/mastra-ai/mastra/tree/main/pubsub)), workflow runners such as inngest and temporal ([workflows/](https://github.com/mastra-ai/mastra/tree/main/workflows)), and clients `client-js`, `react` and `ai-sdk` ([client-sdks/](https://github.com/mastra-ai/mastra/tree/main/client-sdks)).

**Extensibility.** Mastra composes everything through one typed config object and has no plugin API.

- `new Mastra({ agents, workflows, storage, vectors, server, memory, channels, schedules, … })` is generic over the agent and workflow records, so `getAgent('x')` is typed on the server ([mastra/index.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/mastra/index.ts)).
- Primitives are wired by convention injection (`__registerMastra(this)`, `__registerPrimitives`), not through a DI container.
- **Storage is a closed union of 24 domains declared in core.** `DOMAIN_KEYS` enforces the list at compile time ([storage/base.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/base.ts)).
  - Each adapter implements every domain; `PostgresStore` builds all of them ([pg storage/index.ts](https://github.com/mastra-ai/mastra/blob/main/stores/pg/src/storage/index.ts)).
  - `MastraCompositeStore` routes domains to different adapters ([docs](https://mastra.ai/reference/storage/composite)).
  - `init()` creates the tables for every domain the adapter provides, except `knowledge`, which is opt-in. A memoized Proxy runs `init()` lazily on first use ([storageWithInit.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/storageWithInit.ts)).
  - There are no versioned migration files: the DDL lives in each domain's `init()`, plus a `mastra migrate` command ([migrate.ts](https://github.com/mastra-ai/mastra/blob/main/packages/cli/src/commands/migrate/migrate.ts)).
- **Routes.** Built-in routes are a static `SERVER_ROUTES` table. User routes use `registerApiRoute(path, { method, handler, middleware, requiresAuth, … })` and are Hono-typed ([core/server/index.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/server/index.ts)). Features such as channels append to `server.apiRoutes` internally.
- **Lifecycle.** `new MastraServer({ app, mastra }).init()` registers the middleware and routes ([docs](https://mastra.ai/docs/server/server-adapters)), followed by `startWorkers()` and `shutdown()`.

**Optional features cost.** Infrastructure is split into packages with core as a peer, but core keeps many features built in and relies on subpaths, `sideEffects:false` and treeshaking ([tsdown.config.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/tsdown.config.ts)). **Unused storage domains still get tables.**

**Client types.** A script turns each route's Zod schemas into a committed `route-types.generated.ts` ([generator](https://github.com/mastra-ai/mastra/blob/main/packages/server/scripts/generate-route-types.ts), [output](https://github.com/mastra-ai/mastra/blob/main/client-sdks/client-js/src/route-types.generated.ts)). Hand-written resource classes sit on top. `MastraClient.getAgent(id: string)` is not generic over the user's agents ([client.ts](https://github.com/mastra-ai/mastra/blob/main/client-sdks/client-js/src/client.ts)).

**Build and release.**

- **Build:** tsdown, ESM + CJS. Types come from a separate internal types-builder, and internal `@internal/*` packages are bundled in.
- **Changesets** with `fixed` groups (core/server/deployer; CLI/create/playground). The repo is **permanently in pre mode** (`{mode:"pre", tag:"alpha"}`) ([config.json](https://github.com/mastra-ai/mastra/blob/main/.changeset/config.json), [pre.json](https://github.com/mastra-ai/mastra/blob/main/.changeset/pre.json)).
- **Publishing:** an alpha publishes twice a day from a cron ([cron-alpha-publish.yml](https://github.com/mastra-ai/mastra/blob/main/.github/workflows/cron-alpha-publish.yml)), and npm trusted publishing is used ([npm-publish.yml](https://github.com/mastra-ai/mastra/blob/main/.github/workflows/npm-publish.yml)).

### 2. Vercel AI SDK (`vercel/ai`, `ai@7`)

**Packages.** There are more than 80 packages ([packages/](https://github.com/vercel/ai/tree/main/packages)).

- **`ai`** holds generate/stream, agents, UI message streams, middleware and the registry. Its exports are `.`, `./internal` and `./test`. It depends on `@ai-sdk/gateway`, `provider` and `provider-utils`, with `zod` as a peer ([package.json](https://github.com/vercel/ai/blob/main/packages/ai/package.json)).
- **`@ai-sdk/provider`** is **spec-only**: interfaces and errors for every model kind, with one dependency ([package.json](https://github.com/vercel/ai/blob/main/packages/provider/package.json), [index.ts](https://github.com/vercel/ai/blob/main/packages/provider/src/index.ts)).
- **`@ai-sdk/provider-utils`** holds helpers for writing providers ([package.json](https://github.com/vercel/ai/blob/main/packages/provider-utils/package.json)).
- **About 50 provider packages** depend only on `provider` and `provider-utils`, for example [`@ai-sdk/openai`](https://github.com/vercel/ai/blob/main/packages/openai/package.json).
- **UI packages:** `@ai-sdk/react` (`react` as a peer) ([package.json](https://github.com/vercel/ai/blob/main/packages/react/package.json)), plus `vue`, `svelte` and `angular`.
- **`@ai-sdk/mcp`** keeps the Node-only stdio transport on the subpath `./mcp-stdio` ([package.json](https://github.com/vercel/ai/blob/main/packages/mcp/package.json)).

**Extensibility.**

- **Versioned provider specs.** `LanguageModelV4` has `specificationVersion`, `doGenerate` and `doStream` ([language-model-v4.ts](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v4/language-model-v4.ts)). The v2, v3 and v4 specs all still ship, and core upgrades older models through adapters ([resolve-model.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/model/resolve-model.ts)).
- **Composition.** `createProviderRegistry` and `customProvider` combine providers ([provider-registry.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/registry/provider-registry.ts)). Middleware (`transformParams`, `wrapGenerate`, `wrapStream`) is applied with `wrapLanguageModel` ([middleware type](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model-middleware/v4/language-model-v4-middleware.ts), [middleware/](https://github.com/vercel/ai/tree/main/packages/ai/src/middleware)).
- **No routes, data or lifecycle system.** The Host writes the route handler. (I did not read the transport source to check the persistence callbacks.)

**Optional features cost.** Every provider and UI framework is its own package. `"sideEffects": false` is set across the board, frameworks are peers, Node-only code sits on subpaths, and a bundle-size check runs in CI ([tsdown.config.ts](https://github.com/vercel/ai/blob/main/packages/ai/tsdown.config.ts), [tools/](https://github.com/vercel/ai/tree/main/tools)).

**Client types.** Types only, with no runtime coupling: `InferUITools<typeof tools>` gives `UIMessage<META, DATA, TOOLS>`, which gives `useChat<MyMessage>()`. Tool parts form a discriminated union on `` `tool-${name}` `` ([ui-messages.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/ui-messages.ts), [use-chat.ts](https://github.com/vercel/ai/blob/main/packages/react/src/use-chat.ts)).

**Build and release.**

- **Build:** tsdown from a shared base config, ESM-only ([tools/tsdown-config](https://github.com/vercel/ai/blob/main/tools/tsdown-config/index.mts)).
- **Changesets** with independent versions (`fixed: []`) ([config.json](https://github.com/vercel/ai/blob/main/.changeset/config.json)).
- **Publishing:** `changesets/action` on `main` and on `release-v*` backport branches. Snapshot publishes are available, and npm provenance is on ([release.yml](https://github.com/vercel/ai/blob/main/.github/workflows/release.yml)).

### 3. Vercel Chat SDK (`vercel/chat`, `chat@4.43.0`)

The repo was confirmed with `npm view chat`: repository `vercel/chat`, directory `packages/chat`, homepage <https://chat-sdk.dev/docs>.

**Packages** ([packages/](https://github.com/vercel/chat/tree/main/packages)):

- **`chat`**: the core. Its exports are `.`, `./ai`, `./ai/tanstack`, `./workflow`, `./serialization` and a JSX runtime for cards ([package.json](https://github.com/vercel/chat/blob/main/packages/chat/package.json)).
- **18 platform adapters** such as `@chat-adapter/slack`, which exports `.`, `./webhook`, `./api` and others ([slack](https://github.com/vercel/chat/blob/main/packages/adapter-slack/package.json)), plus `adapter-shared`.
- **State adapters:** `state-memory`, `state-redis`, `state-ioredis` and `state-pg` ([state-redis](https://github.com/vercel/chat/blob/main/packages/state-redis/package.json)).
- **Others:** a `catalog` of adapter metadata and the `create-chat-sdk` scaffolder.

**Extensibility.** Composition through a plain config object, with no plugin or middleware chain.

- `new Chat<TAdapters, TState>({ userName, adapters: { slack: createSlackAdapter() }, state: createRedisState(), concurrency, … })` ([types.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/types.ts), [chat.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/chat.ts)).
- **The `Adapter` interface** has required methods (`handleWebhook`, `parseMessage`, `postMessage`, …) and about 25 **optional methods that declare what an adapter can do** (`stream?`, `openModal?`, `scheduleMessage?`, …).
- **Routes.** Each adapter owns one webhook, and `chat.webhooks.<key>(request)` is a typed map built from the adapter keys. The Host mounts one route per adapter.
- **Data.** The only persistence seam is `StateAdapter`, which offers KV, locks, subscriptions, lists and queues. There is no schema or migration layer.
- **Lifecycle.** Adapters call back into `ChatInstance.process*`, and the app registers handlers such as `onNewMention` and `onAction`.
- **Third-party adapters** use the name `chat-adapter-PLATFORM` and get listed through a PR to the catalog ([publishing.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/docs/contributing/publishing.mdx), [building.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/docs/contributing/building.mdx)).

**Optional features cost.**

- One package per platform and per store.
- AI integrations sit on subpaths, with `ai`, `workflow` and `zod` as **optional peers**.
- The web adapter makes its React, Vue and Svelte bindings optional peers on separate subpaths ([web README](https://github.com/vercel/chat/blob/main/packages/adapter-web/README.md)).
- Gaps:
  - `chat` itself does not set `sideEffects:false`; only `catalog` does ([catalog](https://github.com/vercel/chat/blob/main/packages/catalog/package.json)).
  - The official adapters list `chat` under `dependencies`, while the guide tells third parties to make it a peer.

**Client types.** Generics on `Chat<TAdapters, TState>`. `createChatTools()` returns AI SDK `Tool`s, and the web adapter speaks the AI SDK UI stream, so the browser gets its types from the AI SDK ([ai/index.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/ai/index.ts)).

**Build and release.**

- **Build:** tsup, ESM-only, with `splitting` so `serialization` "does not load the Node-only Chat runtime" ([tsup.config.ts](https://github.com/vercel/chat/blob/main/packages/chat/tsup.config.ts)).
- **Changesets** with **one `fixed` group, `["chat", "@chat-adapter/*"]`**, so every package is on 4.43.0 ([config.json](https://github.com/vercel/chat/blob/main/.changeset/config.json), checked directly).
- **Publishing:** with provenance ([release.yml](https://github.com/vercel/chat/blob/main/.github/workflows/release.yml)).

### 4. Better Auth (`better-auth/better-auth`, 1.7.12)

**Packages** ([packages/](https://github.com/better-auth/better-auth/tree/main/packages)):

- **`better-auth`** is the umbrella package ([package.json](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/package.json)).
  - It holds the server, the client (`./client`), framework bindings (`./react`, `./vue`, `./svelte`, `./next-js`, `./tanstack-start`, `./node`, …) and adapter re-exports.
  - **Each first-party plugin has its own subpath:** `./plugins/{admin,organization,two-factor,jwt,magic-link,…}`.
  - Framework libraries and ORM clients are peers.
- **`@better-auth/core`** holds the plugin and context types, the db schema and the adapter factory ([package.json](https://github.com/better-auth/better-auth/blob/main/packages/core/package.json)).
- **Five adapter packages**, each with its ORM as a peer: drizzle, prisma, kysely, mongo, memory ([drizzle](https://github.com/better-auth/better-auth/blob/main/packages/drizzle-adapter/package.json)).
- **Heavy plugins are separate packages** that peer `better-auth` and `@better-auth/core`: `@better-auth/sso`, `stripe`, `passkey`, `api-key`, `oauth-provider`, `scim` and others ([stripe](https://github.com/better-auth/better-auth/blob/main/packages/stripe/package.json), [passkey](https://github.com/better-auth/better-auth/blob/main/packages/passkey/package.json)).
- **The CLI** is published as the npm package `auth` ([cli](https://github.com/better-auth/better-auth/blob/main/packages/cli/package.json), [docs](https://better-auth.com/docs/concepts/cli)).

**Extensibility: the `BetterAuthPlugin` object.** This is the closest analogue to our plugin ([plugin.ts](https://github.com/better-auth/better-auth/blob/main/packages/core/src/types/plugin.ts), [docs](https://better-auth.com/docs/concepts/plugins)). A plugin is a plain object returned by a factory, and only `id` is required. Its fields:

- `init(ctx)` → `{ context?, options? }`
- `endpoints`, built with `createAuthEndpoint(path, { method, body, use }, handler)`
- `middlewares`
- `hooks.before` / `hooks.after`, each with a `matcher`
- `onRequest` / `onResponse`
- **`schema`**: new tables, or extra fields on core tables
- `migrations`, raw Kysely migrations
- `rateLimit`
- `$ERROR_CODES`
- `$Infer`
- `adapter` overrides

**How the schema is built and migrated.**

- `buildAuthTables` reduces over `options.plugins` and merges the fields per table ([get-tables.ts](https://github.com/better-auth/better-auth/blob/main/packages/core/src/db/get-tables.ts)).
- The CLI loads the user's `auth.ts`, so **only the enabled plugins contribute tables**. It then generates a Prisma schema, a Drizzle `schema.ts` or SQL, and `migrate` applies it, but only for Kysely ([generate.ts](https://github.com/better-auth/better-auth/blob/main/packages/cli/src/commands/generate.ts), [migrate.ts](https://github.com/better-auth/better-auth/blob/main/packages/cli/src/commands/migrate.ts)).

**How plugins reach each other.** `ctx.context.getPlugin(id)` and `hasPlugin(id)` (checked directly in [context.ts](https://github.com/better-auth/better-auth/blob/main/packages/core/src/types/context.ts)). They are typed by augmenting `BetterAuthPluginRegistry` through `declare module "@better-auth/core"` ([docs](https://better-auth.com/docs/concepts/plugins#register-a-plugin-type)). This is **the same shape as our `PluginApis` declaration merging and `sdk.plugin()`/`hasPlugin()`**.

**DB adapters.** `createAdapterFactory({ config: { supportsJSON, … }, adapter })` ([factory.ts](https://github.com/better-auth/better-auth/blob/main/packages/core/src/db/adapter/factory.ts), [guide](https://better-auth.com/docs/guides/create-a-db-adapter)).

**Optional features cost.** Per-plugin subpaths plus `sideEffects:false`, heavy features in their own packages, and **tables, endpoints, hooks and rate limits exist only when a plugin is in `plugins[]`**.

**Client types.** No codegen. A client plugin carries a type-only `$InferServerPlugin: {} as ReturnType<typeof serverPlugin>` ([plugin-client.ts](https://github.com/better-auth/better-auth/blob/main/packages/core/src/types/plugin-client.ts)), and `createAuthClient({ plugins })` maps each endpoint path to a typed camelCase method.

**Build and release.**

- **Build:** tsdown, ESM-only, with a `dev-source` export condition that points at `src`.
- **Changesets** with **all 22 public packages in one `fixed` group** ([config.json](https://github.com/better-auth/better-auth/blob/main/.changeset/config.json)).
- **Publishing:** a Version PR, then publish ([release.yml](https://github.com/better-auth/better-auth/blob/main/.github/workflows/release.yml)).

### 5. LangGraph.js (`langchain-ai/langgraphjs`)

**Packages:**

- **`@langchain/langgraph`** is the runtime: StateGraph, Pregel, channels, prebuilt. Its exports are `.`, `./web`, `./channels`, `./pregel`, `./prebuilt`, `./remote`, `./stream` and `./zod`. `@langchain/core` and `zod` are peers ([package.json](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/langgraph-core/package.json)).
- **`@langchain/langgraph-checkpoint`** holds the base interfaces and has no runtime dependencies ([package.json](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint/package.json)).
- **One package per backend** (`-checkpoint-postgres`, `-sqlite`, `-redis`, `-mongodb`). Each depends only on its driver and peers the checkpoint package ([postgres](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint-postgres/package.json)).
- **`@langchain/langgraph-sdk`** is the HTTP client, with `react` as an optional peer ([package.json](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/sdk/package.json)). Framework bindings are separate (`@langchain/react`, plus vue, svelte and angular).
- **`@langchain/langgraph-api`** (a Hono server) and the CLI are separate packages ([api](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/langgraph-api/package.json)).

**Extensibility.**

- **Abstract adapter classes:**
  - `BaseCheckpointSaver`: `getTuple`, `list`, `put`, `putWrites`, `deleteThread` ([base.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint/src/base.ts)).
  - `BaseStore`: one abstract method, `batch(ops)`, with `get`, `put` and `search` built on top ([store/base.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint/src/store/base.ts)).
- **Plugging in.** Adapters are injected at `StateGraph.compile({ checkpointer, store })` ([state.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/langgraph-core/src/graph/state.ts)), and nodes read them through `getStore()` and `getConfig()`.
- **Composition.** A compiled graph can be used directly as a node ([docs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)).
- **Data.** The Postgres saver's `setup()` "MUST be called directly by the user". It runs ordered SQL migrations, versioned by array index in a `checkpoint_migrations` table, under a configurable schema ([index.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint-postgres/src/index.ts), [migrations.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint-postgres/src/migrations.ts)). `PostgresStore` runs its own setup lazily unless `ensureTables: false` ([store/index.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/checkpoint-postgres/src/store/index.ts)).

**Optional features cost.** A backend is a package with its driver, so core has no database dependency. Framework bindings are separate packages, and nothing touches the database until `setup()`.

**Client types.** `useStream<typeof graph>()` unwraps the state, tool calls and subagents with `InferStateType` and related helpers. These are type-only imports of the graph, with no codegen ([use-stream.ts](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/sdk-react/src/use-stream.ts)).

**Build and release.**

- **Build:** a private `@langchain/build` wrapper over tsdown. It reads each entry from an `input` field on the `exports` entries, builds dual ESM + CJS when an export has a `require` condition, and runs attw and publint ([internal/build](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/internal/build/index.ts)).
- **Changesets**, independent except for a fixed api/cli/ui group ([config.json](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/.changeset/config.json), [release.yml](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/.github/workflows/release.yml)).

### 6. Payload CMS (`payloadcms/payload`, v3.92 on branch `3.x`; `main` is now v4 beta)

**Packages** ([3.x/packages](https://github.com/payloadcms/payload/tree/3.x/packages)):

- **`payload`**: the core, holding config, the Local API, collections, fields, hooks, jobs, migrations and the CLI ([package.json](https://github.com/payloadcms/payload/blob/3.x/packages/payload/package.json)).
- **Framework and admin:** `@payloadcms/next` (route handlers, admin views) and `@payloadcms/ui`.
- **Database adapters:** `db-postgres`, `db-sqlite`, `db-mongodb`, … with shared SQL logic in `@payloadcms/drizzle`.
- **Storage:** `storage-{s3,azure,gcs,r2,vercel-blob}`.
- **Email:** `email-{nodemailer,resend}`.
- **Plugins:** `plugin-{seo,search,stripe,multi-tenant,…}`, each exporting `.`, `./client` and sometimes `./rsc` ([seo](https://github.com/payloadcms/payload/blob/3.x/packages/plugin-seo/package.json)).
- **Typed REST client:** `@payloadcms/sdk`.

**Extensibility.**

- **A plugin is `(config: Config) => Config`** ([config/types.ts](https://github.com/payloadcms/payload/blob/3.x/packages/payload/src/config/types.ts), [build-your-own](https://github.com/payloadcms/payload/blob/3.x/docs/plugins/build-your-own.mdx)).
  - The plugin spreads in `collections`, `hooks`, `endpoints` and admin components.
  - It wraps function properties such as `onInit`, calling the user's version first.
- **Experimental `definePlugin({ slug, order, plugin })`** adds ordering and a `plugins` map that lets one plugin adjust another's options. It is typed by augmenting `RegisteredPlugins` ([plugin-api.mdx](https://github.com/payloadcms/payload/blob/3.x/docs/plugins/plugin-api.mdx)).
- **Data comes from the final config.**
  - In development, Drizzle `push` keeps the database in sync.
  - `payload migrate:create` diffs the schema and writes migration files.
  - `prodMigrations` runs them at startup ([migrations.mdx](https://github.com/payloadcms/payload/blob/3.x/docs/database/migrations.mdx)).
- **Routes.** `endpoints` at the root, per collection or per global. They are not authenticated by default ([rest-api](https://github.com/payloadcms/payload/blob/3.x/docs/rest-api/overview.mdx)).
- **Lifecycle.** `onInit`, plus hooks at four levels: root, collection, global and field ([hooks](https://github.com/payloadcms/payload/blob/3.x/docs/hooks/overview.mdx)).
- **Adapters.** `db`, `email` and `kv` adapters are config values ([database/types.ts](https://github.com/payloadcms/payload/blob/3.x/packages/payload/src/database/types.ts)). Storage adapters are plugins ([storage-adapters.mdx](https://github.com/payloadcms/payload/blob/3.x/docs/upload/storage-adapters.mdx)).
- **Admin components are path strings** (`'pkg/client#Component'`), resolved through a generated `importMap.js` ([custom-components](https://github.com/payloadcms/payload/blob/3.x/docs/custom-components/overview.mdx)).

**Optional features cost.** A plugin that is not in `plugins[]` adds no collections, tables, migrations, types or import-map entries. Each plugin is its own package with `payload` as a peer, and the docs recommend an `enabled` flag.

**Client types.** **Codegen:** `payload generate:types` turns the config into JSON Schema and then into `payload-types.ts`, which augments `GeneratedTypes` in `payload` ([generating-types.mdx](https://github.com/payloadcms/payload/blob/3.x/docs/typescript/generating-types.mdx)). Plugins add to it through `typescript.schema`.

**Build and release.**

- **Build:** SWC, then tsc, ESM-only. In development the exports point at `src`, and `publishConfig.exports` swaps them to `dist` for publishing.
- **No Changesets:** a custom `tools/releaser` publishes every package in lockstep ([tools/releaser](https://github.com/payloadcms/payload/tree/3.x/tools/releaser), [publish-release.yml](https://github.com/payloadcms/payload/blob/3.x/.github/workflows/publish-release.yml)).

### 7. Inngest (`inngest/inngest-js`, `inngest@4.26`)

**Packages:**

- **`inngest`** holds the client, functions, steps, `serve`, realtime and React hooks ([package.json](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/package.json)).
  - **One subpath per framework adapter** (`./next`, `./express`, `./hono`, `./node`, `./lambda`, …).
  - **Every framework is an optional peer.**
  - It sets `"sideEffects": false`.
- **Middleware packages:** `@inngest/middleware-{encryption,sentry,validation}`, each with `inngest >=4 <5` as a peer ([encryption](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/middleware-encryption/package.json)).
- **`@inngest/test`** ([package.json](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/test/package.json)).
- **`@inngest/realtime`** is deprecated in favour of `inngest/realtime` ([package.json](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/realtime/package.json)).

**Extensibility.**

- **v4 class middleware** ([middleware.ts](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/src/components/middleware/middleware.ts), [ARCHITECTURE.md](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/src/components/middleware/ARCHITECTURE.md), [lifecycle docs](https://www.inngest.com/docs/reference/typescript/v4/middleware/lifecycle)):
  - Write `class X extends Middleware.BaseMiddleware` and register the class itself; a fresh instance is made per request.
  - Observers: `onRunStart`, `onStepComplete`, …
  - Transforms: `transformFunctionInput`, …
  - Wrappers that call `next()`: `wrapRequest`, `wrapStep`, …
  - `static onRegister` for one-time setup.
  - Experimental: **`static functions()` lets a middleware ship its own background functions**, which are added only when it is registered ([CHANGELOG](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/CHANGELOG.md)).
- **Framework adapters.** Each is a small `serve()` over `InngestCommHandler`, which is exported so third parties can write their own ([hono.ts](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/src/hono.ts)).
- **Events.** v4 replaced `EventSchemas` with `eventType(name, { schema })` over Standard Schema ([v3→v4 guide](https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4), [triggers.ts](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/src/components/triggers/triggers.ts)).

**Optional features cost.**

- The build uses `unbundle: true`, and adapters sit on subpaths with optional peers ([tsdown.config.ts](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/tsdown.config.ts)).
- Middleware hooks are left undefined rather than no-ops "as a performance optimization", since each `wrapStep` adds a promise to every step.

**Client types.** `ApplyAllMiddlewareCtxExtensions<TMw>` merges each middleware's `transformFunctionInput` return type into the handler's `ctx` ([types.ts](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/src/types.ts), [Inngest.ts](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/src/components/Inngest.ts)). One `eventType` value types `send`, triggers and `waitForEvent`.

**Build and release.**

- **Build:** tsdown, ESM + CJS, published from `dist`.
- **Changesets**, independent ([config.json](https://raw.githubusercontent.com/inngest/inngest-js/main/.changeset/config.json)).
- **Publishing:** `npm publish --provenance` through a custom script ([publish.js](https://raw.githubusercontent.com/inngest/inngest-js/main/scripts/release/publish.js)). A PR label publishes a `@pr-<n>` prerelease ([release.yml](https://raw.githubusercontent.com/inngest/inngest-js/main/.github/workflows/release.yml)).

## Recurring patterns

1. **A spec-only or small core package, plus one package per adapter, with the core as a peer.**
   - Spec packages: `@ai-sdk/provider`, `@langchain/langgraph-checkpoint`, `@better-auth/core`.
   - Adapter families: Mastra `stores/*`, Better Auth `*-adapter`, LangGraph `checkpoint-*`, Chat SDK `state-*`/`adapter-*`, Payload `db-*`/`storage-*`.
   - The adapter's driver is a dependency of the adapter package only, so the core never pulls in `pg`, `redis` or `@slack/web-api`. Every SDK surveyed does this; it is the strongest consensus in the survey.
2. **Optional features live outside the core's import graph.** Three ways to achieve this, often combined:
   - **(a)** A separate package (all seven).
   - **(b)** A subpath export plus `sideEffects:false` (AI SDK, Better Auth, Inngest, Mastra).
   - **(c)** An optional peer for framework bindings (Chat SDK, Inngest, LangGraph SDK).
     Better Auth mixes (a) and (b): light plugins are subpaths of `better-auth`, heavy ones that need their own SDK are separate packages.
3. **Two extension styles, chosen by whether features own data and routes.**
   - **Declarative plugin objects or config transforms** (Better Auth, Payload) when features contribute **tables, endpoints, hooks and rate limits** that the core must merge.
   - **Interface adapters plus explicit composition** (AI SDK, LangGraph, Chat SDK, Inngest, Mastra) when the core owns the behaviour and only infrastructure varies.
4. **The schema follows the config.** The two SDKs whose features own tables build the schema from the enabled plugins: Better Auth's `buildAuthTables` over `plugins[]`, and Payload's config-derived schema with `migrate:create`. The counter-example is Mastra, whose closed domain union means every adapter creates every domain's tables on init. Adapter packages that own a few tables (LangGraph) ship versioned SQL behind an explicit `setup()` under a configurable schema.
5. **Typed cross-feature access through an augmentable registry.** Better Auth's `getPlugin`/`hasPlugin` with `BetterAuthPluginRegistry`, and Payload's `RegisteredPlugins`, match our `PluginApis` plus `sdk.plugin()`. The other SDKs avoid service-locator lookups entirely: values are passed in explicitly (`compile({ checkpointer, store })`, `new Chat({ state })`, `wrapLanguageModel(model, middleware)`).
6. **Client types are inferred from server values, with no codegen.**
   - Inference: AI SDK (`InferUITools`), Better Auth (`$InferServerPlugin`), LangGraph (`useStream<typeof graph>`), Inngest (middleware `ctx`).
   - Codegen: Payload (it must cover user-defined collections) and Mastra's own fixed routes (not inferred from the user's instance).
7. **Capabilities as optional interface members.** Chat SDK adapters declare features with `stream?`, `openModal?` and similar; AI SDK providers do the same with `transcriptionModel?` and others. The core checks for presence instead of keeping a separate flag.
8. **Build and release.**
   - tsdown in 5 of 7 (AI SDK, Better Auth, Mastra, LangGraph via a wrapper, Inngest); tsup for the Chat SDK; SWC + tsc for Payload.
   - ESM-only in 4 (AI SDK, Chat SDK, Better Auth, Payload); dual in 3 (Mastra, LangGraph, Inngest).
   - Changesets in 6 of 7. **SDKs whose adapters must match the core use one `fixed` group** (Better Auth, the Chat SDK, Payload lockstep); provider ecosystems version independently (AI SDK, Inngest).
   - Provenance or trusted publishing everywhere it was checked.

## Trade-offs, framed against our Bot SDK

Our `BotSdkPlugin` (`packages/bot-sdk/core/server/plugin.ts`) is already Better Auth-shaped. It has `id`, `requires`/`uses` (dependency ordering), `router`, `routes`, `rateLimits`, `init` returning `{ api }`, `start`/`stop`, `databaseHooks`, `deleteUser`/`exportUser`/`rotateKeys`, and `PluginApis` declaration merging for `sdk.plugin(id)`. Measured at HEAD 57e2e4f3:

- `plugins/bot/server` is **15,549 lines in 50 entries**.
- `sdk.plugin("…")` appears **about 110 times in non-test, non-eval source**; `bot/server/turn.ts` alone has 14.
- `bot` declares `requires: ["models","runner"]` and `uses: ["computer","memory","skills","knowledge","mcp"]`; `channel` requires `models`, `bot` and `runner`.
- The schema is composed **statically**: `core/server/db/schema.ts` imports every plugin's schema, so every Host gets every table. This is the Mastra failure mode on success criterion (c).

The trade-offs against the patterns above:

- **Plugin object vs. interface adapters plus composition.**
  - The plugin-object style earns its keep where a feature really contributes data, routes, hooks and lifecycle that the core merges. That fits Memory, Knowledge, Channels, MCP and Skills, as in Better Auth.
  - Infrastructure (`BlobStore`, `BotSdkRuntime`, `JobRunner`, `ComputerProvider`, `ChannelAdapter`) is better served by **spec interfaces in a tiny package, with each adapter in its own package**, as in `@ai-sdk/provider` or `@langchain/langgraph-checkpoint`. Plugins are the wrong tool here.
  - The two styles coexist in Better Auth (plugins plus `createAdapterFactory`) and in Payload (plugins plus `db`/`email` adapters). This suggests keeping both and moving infrastructure out of "plugins": today `runner` and `computer` are plugins.
- **`sdk.plugin("x")` service locator vs. explicit injection.**
  - Better Auth shows the locator scales to a large ecosystem when it is typed through a registry and used sparingly, mostly through `hasPlugin` for soft integration.
  - At about 110 call sites, our usage is the coupling the explicit-injection SDKs avoid. With `compile({ checkpointer })` or `new Chat({ state })`, a dependency shows in the constructor's type. With a locator, the dependency shows only in `requires` strings and at runtime.
  - A middle path seen in Inngest: a feature declares what it adds to the context, and the types merge (`ApplyAllMiddlewareCtxExtensions`).
- **One big feature package vs. many.**
  - No surveyed SDK has a 15K-line feature that bundles several separable capabilities. Mastra comes closest, keeping memory, channels and schedules inside `@mastra/core`, and pays for it with tables for every domain and a heavy core.
  - The Bot plugin's sub-features (Triggers/Router, Routines, Check-ins, Helpers, Auto-review, context engineering) would be modules or plugins in the Better Auth or Payload model, each declaring its own schema.
- **Schema from the enabled features.**
  - Option 1: a schema built from `plugins[]`, with generated migrations per Host, as Better Auth and Payload do. It needs a CLI that loads the Host's config.
  - Option 2: each package ships its own versioned SQL migrations under a configurable Postgres schema, applied by an explicit `migrate()`/`setup()`, as LangGraph does. Simpler, but cross-package foreign keys get harder.
  - Both meet (c); our current static composition does not.
- **Client types.**
  - Our merged oRPC router infers types much like Better Auth's `$InferServerPlugin` does, without codegen, so that route stays open.
  - Mastra's generated-route-types approach is the one to avoid if Hosts compose features, because it cannot see the Host's own composition.
- **Versioning.**
  - If adapters and feature packages must match the core's wire and schema versions, the precedent is **one Changesets `fixed` group under one scope**, as Better Auth and the Chat SDK do. Independent versions suit a stable spec package with a long tail of providers (AI SDK).
  - tsdown, ESM-only and provenance publishing match `docs/research/sdk-packaging.md`, so nothing here contradicts that note.

## Not verified

- **Mastra:** whether `domain: false` on a composite store actually prevents table creation in the default parent (my reading of `base.ts` says no). Also unchecked: what the `./di` and `./features` exports hold, and the stable-release workflow.
- **Vercel AI SDK:** the ai-sdk.dev pages and the v7 release notes were not read; the facts come from source. The transport and persistence-callback internals were not read either.
- **Chat SDK:** the `docs/ai/types.mdx` and state-adapter docs pages were not read.
- **Better Auth:**
  - `trustedOrigins` appears in a docs plugin example but not in `plugin.ts` on `main`.
  - The docs' rate-limit example says `limit` where the type says `max`.
  - The `inferAdditionalFields` helper was not re-read.
- **LangGraph.js:** how custom routes are declared in `langgraph.json`, the `setup()` details of the SQLite, Redis and Mongo savers, and what `checkpoint-validation` contains.
- **Payload:** the internals of `tools/releaser`. v4-beta differences beyond the package list were not checked.
- **Inngest:** whether it publishes to JSR, and how realtime topic types are inferred.
- **Our own counts:** the `sdk.plugin(` count comes from a Grep over `packages/bot-sdk`, about 238 matches in all, including tests, evals and the README. It was not hand-audited.
