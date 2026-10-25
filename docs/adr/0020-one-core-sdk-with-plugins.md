---
Status: superseded by ADR 0029
---

# One core SDK with plugins, like Better Auth

Supersedes ADR 0019. ADR 0019 split chat-sdk into a family of SDKs, each with its own package, Postgres schema and factory, joined by plain string ids and wired clean-up. Charting step 0 (#411) showed the price: eleven `ON DELETE CASCADE` foreign keys into `conversation` and `message` would have to be rebuilt as hooks, the assistant's columns would have to leave `conversation` for one-to-one tables, and every table would have to move schema. Better Auth solves the same problem (a small core that many optional features extend) with one instance and plugins, so the SDK copies that architecture. Its end goal is the always-on Bot, so it is the **Bot SDK**, and the assistant is one of its plugins.

- **One instance, one factory.** `createBotSdk({ databaseUrl, blobStore, logger, plugins: [models(), runner(), assistant(), memory()] })` replaces `createChat` and ADR 0019's per-SDK factories. It has one `start`/`stop`/`migrate`, and its `deleteUser`/`exportUser` run across every plugin. The assistant and bot plugins share one runner because they live in one instance.
- **The core** holds the infrastructure (Postgres pool, migrations, blob store, pub/sub, logger, hooks, the HTTP handler and its `basePath`) and the Conversation: Conversation, Message, the message tree (ADR 0001), base parts and attachments. Conversation is to this SDK what `user` is to Better Auth: what every plugin hangs off.
- **Everything else is a plugin**: models, runner, assistant (today's chat), bot (always-on Bots; ADR 0019 called it `agent`), memory, knowledge, computer and channels. A plugin declares `requires` (memory requires runner and models), and the core throws at startup when one is missing.
- **One Postgres schema, `chat`.** A plugin declares its own tables only if it needs them, and may add fields to core tables (Better Auth's additional fields): the assistant's `model`, `reasoning_effort`, `project_id`… stay on `conversation` and `message`, declared by the assistant plugin. Foreign keys between plugin and core tables are allowed, so the existing cascades stay.
- **A field DSL and `generate`.** Plugins declare fields in a small DSL (type, required, `references` with `onDelete`, indexes). A `generate` command writes the Host's Drizzle schema and migrations from the core plus the plugins it enables, because a static Drizzle table can't take typed columns from a plugin.
- **Endpoints and client.** Plugins contribute oRPC routers, merged under one `handler` and one `basePath`. `createBotSdkClient({ plugins: [assistantClient()] })` infers the routes from the server plugins (Better Auth's `$InferServerPlugin`). Screens stay Host-owned (ADR 0005).
- **Hooks.** Endpoint hooks (before/after a route) and database hooks (before/after create, update, delete on a model). Postgres cascades fire no app hooks, so a plugin that holds data outside Postgres (blob bytes, queued jobs) uses a `before` delete hook inside the transaction to collect what it must clean and an `after` hook, after the commit, to clean it.
- **Packaging.** One package, `@ai-chat/bot-sdk`, with every plugin a subpath export (`@ai-chat/bot-sdk/plugins/memory`), the bot, computer and channels plugins included. A Host copies the one folder and loads only the plugins it enables.

The build order (#409) still sets when each plugin is extracted. Step 0 carves chat-sdk into the core, a `models` plugin and an `assistant` plugin, and builds the field DSL and `generate`; runner, memory and knowledge stay inside `assistant` until their own steps.

_Amended 2026-10-16 ([#437](https://github.com/Daanish2003/ai-chat/issues/437), [#441](https://github.com/Daanish2003/ai-chat/issues/441)): the field DSL is Drizzle itself. Each plugin's static schema module gives Drizzle column builders plus an index callback for each core table it extends, and one hand-written module composes the core and every plugin into the `chat` schema. `generate` is deferred until a Host enables a subset of plugins; until then every Host enables them all, so it would write a fixed file. Plugin export paths end in `/server`, `/client` and `/ui` (for example `@ai-chat/bot-sdk/plugins/memory/server`), not the bare plugin path above._

## Considered Options

- **A family of SDKs, each with its own Postgres schema (ADR 0019)**: rejected. Cross-schema references can't use foreign keys, so every cascade becomes hand-wired clean-up, plugin columns become one-to-one tables, and every table has to move schema.
- **Plugins export plain Drizzle tables, with no generator**: rejected. A plugin can't add a typed column to a core table without a generation step.
- **Conversation as a plugin, with an infrastructure-only core**: rejected. Assistant, bot and memory all hang off it, so it would be required by nearly everything.
- **Every plugin its own package, or heavy plugins separate (as Better Auth does with `@better-auth/passkey`)**: rejected. The Bot is the goal, not an add-on, and one package is simpler to copy.
- **Naming it `chat-sdk` or `agent-sdk`**: rejected. Chat is now one plugin, and "agent SDK" clashes with Anthropic's and OpenAI's agent SDKs and with the glossary's Bot and Helper.

## Consequences

- Step 0 moves no tables. The `chat` schema stays, and the assistant's columns stay where they are.
- ADR 0019's "one top-level config that builds everything inside" rejection no longer holds: plugins in one instance share a runner, and a test builds an instance with only the plugins it needs.
- The field DSL and `generate` are new code that step 0 must build before any plugin adds a field.
- Memory, knowledge and the runner become plugins in their build steps, not SDKs, and their data stays in `chat`.
