---
Status: accepted
---

# A family of copied SDKs, each with its own package, schema and factory

ADR 0005 made chat-sdk one copied, stack-agnostic package. The always-on Bot (Wayfinder #383) needs a durable runner, Memory, Knowledge, a Computer and Channels that both the assistant and Bots use, so chat-sdk is split into a **family of SDKs**. Each SDK follows ADR 0005's rules, and a Host copies the ones it needs.

- **The family and its graph.** Dependencies point downward only:
  - `platform`: the Postgres pool and migration runner, blob store, pub/sub and logger seams with their default adapters.
  - `models`: model adapters, provider credentials and the keyring (ADRs 0003, 0007, 0010), and quotas and usage. Depends on `platform`.
  - `runner`: the durable runner (ADR 0011, #391). Depends on `platform`.
  - `memory` and `knowledge`: depend on `runner`, `models` and `platform`.
  - `conversation`: Conversation, Message, parts, the message tree (ADR 0001), attachments and ratings. Depends on `platform`.
  - `computer`: the Bots' Computer (#396). Depends on `platform`.
  - `channel`: a leaf defining the Channel interface (inbound, outbound, sync), with its adapters built by the Host.
  - `chat-sdk` (the assistant) and `agent` (Bots) sit on top as **siblings that never import each other**. chat-sdk keeps Runs, Branches, Projects, Shared links, search and artifacts. `agent` also uses `channel` and `computer`. A Bot's Conversation is the same message tree, kept append-only by `agent`, not by storage.
- **One Postgres schema per SDK**, each with its own SQL migrations and `migrate()`. References across SDKs are plain string ids with no foreign keys, as user ids already are.
- **Opaque scopes.** Knowledge is scoped by a scope id it never interprets. chat-sdk passes a Project id; `agent` passes whatever its build step decides.
- **A factory per SDK** (`createRunner`, `createMemory({ runner, models })`, `createAgent({ runner, memory, knowledge, channels, computer })`…), each with `start`/`stop`/`migrate` where it has state. The Host builds and wires them, and dependents take instances, so two top SDKs share one runner.
- **Clean-up is wired, not subscribed.** Every SDK with user data has `deleteUser(id)` and `exportUser(id)`, and the Host calls each one. A lower SDK exposes `deleteBySource(ref)`, which the top SDK calls from `conversation`'s delete hook. Memory never imports `conversation`.
- **No shared harness yet.** The Run loop stays in chat-sdk and the Turn loop in `agent`. A shared harness is extracted only once both loops show the same code.
- **Copying.** Cross-SDK imports use the package name (`@ai-chat/runner`): a workspace package here, a tsconfig `paths` alias in a Host. Inside an SDK, imports stay relative. Each SDK's README lists the SDKs it needs. An SDK with an HTTP surface or screens uses ADR 0005's `core/{shared,server,client}` plus Host-owned `ui/`, with its own `handler` on its own `basePath`. `platform`, `models` and `runner` have no `ui/`.

When each extraction happens is set by the build order (#409), not here.

## Considered Options

- **Agent depends on chat-sdk for Conversations**: rejected. It breaks the siblings rule and drags Runs and Projects into every Bot Host.
- **The agent keeps its own message log**: rejected. The glossary says every app shows the same Conversation, with the additive chat features.
- **One foundation package**: rejected. Infrastructure seams and calling models on keys change for different reasons, and the runner needs only the first.
- **Ports only, with no shared package**: rejected. Every Host would rebuild the same adapters.
- **Fixed sibling folders with relative cross-SDK imports**: rejected. They break pnpm and turbo package boundaries in this repo.
- **One top-level config that builds everything inside**: rejected. It's harder to test, and two top SDKs couldn't share a runner.
- **The Computer as a module inside `agent`**: rejected. It has its own infrastructure and a small interface (wake, shell, files, screen).

## Consequences

- Existing jobs, Memory and Knowledge rows (and later Conversation rows) move out of the `chat` schema into their SDK's schema, which takes data migrations.
- Memory and Knowledge lose their imports of chat code, and their source references become string refs.
- A Host copying only chat-sdk now copies `platform`, `models`, `runner`, `memory`, `knowledge` and `conversation` too, and adds one `paths` alias per SDK.
