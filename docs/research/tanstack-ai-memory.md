# @tanstack/ai-memory and how it fits a Run

Research for issue #216 (child of the map #215). Researched on 2026-10-12.

How to read the sources:

- **Package.** `@tanstack/ai-memory` 0.2.11 and 0.2.13 were read from their npm tarballs (`https://registry.npmjs.org/@tanstack/ai-memory/-/ai-memory-<version>.tgz`). Paths below are relative to the package's `src/`. Versions, dates and peer ranges come from `pnpm view @tanstack/ai-memory`.
- **Core.** `@tanstack/ai` 0.66.0 was read from the installed copy (`node_modules/.pnpm/@tanstack+ai@0.66.0_zod@4.6.5/node_modules/@tanstack/ai/src/`), marked `AI/` below.
- **Docs.** `docs/memory/*.md` and `packages/ai-memory/CHANGELOG.md` on `TanStack/ai` `main`, read through the GitHub API.
- **Unverified.** Nothing here was run. Timing claims follow from reading the code.

---

## Answer

1. **It exists, and 0.2.11 is the version for us.** Each release peers on exactly one `@tanstack/ai` minor. 0.2.11 (2026-10-08) peers `@tanstack/ai ^0.66.0`. 0.2.12 needs `^0.67.0` and 0.2.13 (latest) needs `^0.68.0`. The source of 0.2.11 and 0.2.13 is byte-identical, so pinning 0.2.11 loses nothing.
2. **It is one `ChatMiddleware`.** `memoryMiddleware({ adapter, scope })` goes in the `middleware` array next to compaction. Recall runs once before the first model call. Save runs in `onFinish` through `ctx.defer`.
3. **The adapter contract is two methods.** A Postgres adapter implements `recall(scope, query)` and `save(scope, turn)`. `inspect` and `listFacts` are optional and only feed devtools.
4. **Save is deferred, but not to a background job.** `ctx.defer` only means "don't block streaming". `chat()` awaits every deferred promise in its `finally` before the stream ends. So an extraction call inside `save` would hold our Run open after the reply finishes. To follow ADR 0011, `save` should enqueue a durable job and return.
5. **The middleware does almost nothing itself.** It takes the last user text as the query and appends what `recall` returns to the system prompts and tools. After the reply it hands `{ user, assistant }` text to `save`. Extraction, ranking, rendering, profiles, scoping and expiry all belong to the adapter.
6. **It is MIT and young but stable.** First published 2026-08-04, 27 versions in ten weeks, nearly all of them dependency bumps. `types.ts` and `middleware.ts` are identical from 0.1.11 (2026-09-10) to 0.2.13.

---

## 1. Versions, licence, maturity

| Version | Published  | Peer `@tanstack/ai` |
| ------- | ---------- | ------------------- |
| 0.1.0   | 2026-08-04 | `^0.43.0`           |
| 0.2.0   | 2026-09-17 | `^0.55.0`           |
| 0.2.10  | 2026-10-06 | `^0.65.0`           |
| 0.2.11  | 2026-10-08 | `^0.66.0`           |
| 0.2.12  | 2026-10-09 | `^0.67.0`           |
| 0.2.13  | 2026-10-09 | `^0.68.0` (latest)  |

- **Licence.** MIT, "Copyright (c) 2025 Tanner Linsley" (`LICENSE` in the tarball). It is published from `TanStack/ai` `packages/ai-memory` by GitHub Actions with npm provenance.
- **Lockstep.** It is released together with `@tanstack/ai`. Since the `^x.y.z` change ([#1071](https://github.com/TanStack/ai/pull/1071)), every `@tanstack/ai` minor forces an `ai-memory` patch. Upgrading `@tanstack/ai` means bumping this too.
- **Dependencies.** It depends on `@tanstack/ai-event-client ^0.13.1`, which is already in our tree. Its other peers (`redis`, `ioredis`, `@honcho-ai/sdk`, `@vectorize-io/hindsight-client`, `vitest`) are all optional (`peerDependenciesMeta`).
- **Changelog.** `CHANGELOG.md` has two real changes since 0.1.x. 0.2.0 ([#1388](https://github.com/TanStack/ai/pull/1388)) published the contract suite as `@tanstack/ai-memory/testkit`. [#1417](https://github.com/TanStack/ai/pull/1417) added a README. Everything else is "Updated dependencies".
- **Entry points.** `.`, `./in-memory`, `./redis`, `./mem0`, `./honcho`, `./hindsight` and `./testkit`.

## 2. The adapter contract

From `types.ts`. This file is identical in 0.1.11, 0.2.0, 0.2.11 and 0.2.13.

```ts
type MemoryScope = Scope; // from @tanstack/ai: { threadId: string; userId?; tenantId?; namespace? }
interface MemoryTurn {
  user: string;
  assistant: string;
}

interface MemoryAdapter {
  readonly id: string;
  readonly name?: string;
  recall: (scope: MemoryScope, query: string) => Promise<RecallResult>;
  save: (scope: MemoryScope, turn: MemoryTurn) => Promise<Array<SaveReceipt>>;
  inspect?: (scope: MemoryScope) => Promise<MemorySnapshot>; // devtools only
  listFacts?: (scope: MemoryScope) => Promise<Array<MemoryFact>>; // devtools only
}

interface RecallResult {
  systemPrompt: string; // '' = inject nothing
  fragments?: Array<{ text: string; source: string }>;
  tools?: Array<Tool>; // merged into the run's tools
  toolGuidance?: string; // injected ahead of systemPrompt
  raw?: unknown;
}
interface SaveReceipt {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  raw?: unknown;
}
```

A Postgres adapter must provide the following:

- **`id`.** A stable string, used in logs and event names (`memory:<id>`).
- **`recall`.** Turns `(scope, query)` into one rendered `systemPrompt` string. Ranking, the profile and similarity search all happen here.
- **`save`.** Turns `(scope, { user, assistant })` into receipts. The docs and the type comments say extraction lives here ("Extraction (turn → stored facts) happens HERE, inside the adapter", `types.ts:150`).
- **Scope isolation.** This is the adapter's job ([custom-adapter.md](https://github.com/TanStack/ai/blob/main/docs/memory/custom-adapter.md)). That guide walks through a pgvector adapter as its example.
- **The contract suite.** `runMemoryAdapterContract(label, factory)` from `@tanstack/ai-memory/testkit` (`testkit/contract.ts`). It checks receipts, a save→recall round-trip, an empty recall, and isolation across `userId` and `tenantId`. It never asserts isolation between two threads of the same user, so a user-wide adapter passes. Its round-trip test expects a saved turn to be recallable right away, so an adapter whose `save` only enqueues a job needs the test factory to run the job inline.

## 3. How it hooks into a Run

`memoryMiddleware(options): ChatMiddleware` (`middleware.ts:107`). Its options are `adapter`, `scope` (a value, or `(ctx) => scope`), `role` (`'recall+save'`, the default, or `'save-only'`), and `onRecall` / `onSave` callbacks.

### Recall: `onConfig` at `phase === 'init'` (`middleware.ts:127`)

- **Query.** It runs once per `chat()`, before the first model call. The query is the plain text of the last `user` message. Images, documents and tool parts are dropped (`getMessageText`).
- **What gets injected.** It awaits `adapter.recall`. It appends `toolGuidance` and then `systemPrompt` to `config.systemPrompts`. It adds `tools` whose names are not already taken.
- **Latency.** Recall blocks the first model call, so an embedding plus a query adds directly to time-to-first-token.
- **Devtools snapshot.** When the adapter has `inspect`, recall also calls `inspect`/`listFacts` to build a devtools snapshot. It then adds one `CUSTOM` `memory:state` chunk to the stream (`onChunk`). Our Run log would record that chunk too, so leaving `inspect` off a production adapter avoids both the extra query and the extra chunk.
- **Fits beside compaction.** In `run.ts` it slots in next to compaction, as `middleware: [compaction.middleware, memoryMiddleware(...)]`. The injected text comes out of `contextMarginTokens` (2,000, `compaction.ts`). Whether `@tanstack/ai-compaction` counts system prompts was not checked (**unverified**), so keep the injected block short.

### Save: `onFinish` with `ctx.defer` (`middleware.ts:225`)

- **Only on success.** It runs only on `onFinish`. A Stop (`onAbort`) or an error saves nothing.
- **The turn is text only.** `turn = { user: last user text, assistant: info.content }`. `FinishInfo.content` is the "Final accumulated text content" (`AI/activities/chat/middleware/types.ts:525`). Tool calls, tool results, reasoning and attachments are not passed.
- **No ids.** The middleware gets no messageId and no Conversation id. The only identity it has is `scope`.
- **`ctx.defer` waits.** It pushes the promise onto `deferredPromises` (`AI/activities/chat/index.ts:1090`). The run's `finally` awaits them with `Promise.allSettled` (`index.ts:1494-1497`), and the type comment says "Deferred promises do not block streaming and are awaited after the terminal hook" (`AI/.../middleware/types.ts:240-243`). Every chunk is out by then, but our `for await` over `chat()` in `startRun` doesn't end until `save` resolves. The Message's final write waits on it, and so does the Run's `finally`.
- **Failures are swallowed.** Errors in recall and save emit `memory:error` and never fail the Run.
- **No recall-only role.** `role` is only `'recall+save'` or `'save-only'`. To recall without saving inline, the adapter's `save` has to be cheap: enqueue a job, or do nothing.

### Scope in our Runs

- **`threadId` is required.** `Scope.threadId` is required (`AI/scope.ts:29`). Its doc comment says `threadId` alone is not an authorization boundary, so `userId` must come from the trusted server.
- **Our Run's `threadId` is not the Conversation.** `startRun` passes `threadId` to `chat()` only on a resumed Run (`run.ts` around line 230). Otherwise `chat()` picks its own `threadId`, and our Run log falls back to the messageId (`run.ts` around line 338).
- **So derive the scope from our own context.** Use a scope function over `ctx.context` (our `HostToolContext`, which carries the user and the Conversation): `{ threadId: conversationId, userId }`.
- **What the built-in adapters do.** `inMemory`/`redis` match `threadId` exactly (`internal/store.ts`, `sameScope`), so their memory is per Conversation. mem0 maps `threadId` to `run_id` (`providers/mem0/index.ts:79`).
- **A user-wide store has to choose to ignore `threadId`.** Memories that span Conversations need an adapter that filters on `userId` and ignores `threadId` for reads. That is allowed (`userId` is documented as "for cross-thread recall"), but the shipped adapters don't do it.

## 4. What it does itself and what it leaves to the adapter

| Concern                                        | `@tanstack/ai-memory`                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When to recall and save                        | Middleware: recall at init, save deferred after `onFinish`.                                                                                                                                                                                                                                                          |
| Query                                          | Middleware: the last user text only. No query rewriting.                                                                                                                                                                                                                                                             |
| Injection                                      | Middleware: appends system prompts and adds tools.                                                                                                                                                                                                                                                                   |
| Extraction (turn → facts)                      | **Adapter.** The built-in `inMemory`/`redis` store the raw turn and accept an optional `extract(turn, scope)` hook plus an optional `embedder` (`internal/store.ts`, `BuiltinOptions`). There is no LLM extraction and no add/update/delete reconciliation. mem0, Honcho and Hindsight do theirs on the vendor side. |
| Ranking and similarity                         | **Adapter.** The built-ins score lexically, by recency, and by cosine similarity when an embedder is given.                                                                                                                                                                                                          |
| Rendering the prompt                           | **Adapter.** The built-ins accept `render`.                                                                                                                                                                                                                                                                          |
| Profiles ("top Memories")                      | Not provided. Our `recall` builds one.                                                                                                                                                                                                                                                                               |
| Scope isolation, expiry, invalidation, history | **Adapter.** The built-ins have `expiresAt`. Nothing models invalidation.                                                                                                                                                                                                                                            |
| Memory tools for the model                     | Optional, through `RecallResult.tools` (Hindsight returns retain/recall/reflect).                                                                                                                                                                                                                                    |
| Devtools                                       | Middleware: `memory:*` events on `aiEventClient` and the `memory:state` chunk.                                                                                                                                                                                                                                       |

## 5. ADR 0013 against the package

### What it gets right

- **The package exists.** It has a version for `@tanstack/ai` 0.66.0 (0.2.11), and it is MIT.
- **The interface is `recall`/`save`.** A Postgres + pgvector adapter is the documented way to add a backend (`docs/memory/custom-adapter.md`).
- **It wires in like any other TanStack middleware.** It goes in the same `middleware` array as compaction.
- **Extraction belongs in the adapter.** The Mem0-style pipeline (pull candidates, find similar ones, decide add/update/delete/no-op, mark invalid) is exactly what the package leaves to `save`. The package supplies none of it, so we write all of it.

### What it gets wrong or leaves out

- **The durable runner doesn't come for free.** `save` runs in-process inside `chat()`, and the Run waits for it. To keep "the durable runner (ADR 0011) asks the Background Model", `save` must only enqueue a job, or skip and let our Run-end code enqueue it.
- **The middleware's turn is thinner than ADR 0013's "new Messages".** It hands over one `{ user, assistant }` text pair: no tool calls, no attachments, no ids. The Run already has the messageId and the stored parts. So the job is better enqueued from `startRun`'s end with the messageId, reading the Messages from the database, with the middleware's `save` doing nothing.
- **Aborted or failed Runs make no Memories through the middleware.** Enqueueing from `startRun` would let us decide that ourselves.
- **The profile is ours to build.** The package has no notion of a profile. Our `recall` builds "a short profile of top Memories" plus similarity hits and returns them as one `systemPrompt`.
- **`search_past_chats` belongs in our Host tools.** It could come back as `RecallResult.tools`, but those tools bypass our Host-tool wrapping (`trackTools`: the tool budget and parts tracking in `run.ts`). It belongs with the other Host tools, so the package adds nothing there.
- **Scope needs care.** `threadId` is required, and our Run's `threadId` is not the Conversation id. The adapter must recall per `userId` across Conversations. The shipped adapters are per thread.
- **The extra dependency is small.** `@tanstack/ai-memory` adds the middleware (about 400 lines), the types and a contract suite. The cost is a lockstep bump on every `@tanstack/ai` upgrade. Since we would use the type, the middleware's recall-at-init and the testkit, and nothing of its save path, a hand-written `ChatMiddleware` is an equally small alternative. Either way the schema work (a Memory table, `pgvector`) and the Background Model call are unchanged.

## Sources

- npm: https://www.npmjs.com/package/@tanstack/ai-memory. Tarballs read: https://registry.npmjs.org/@tanstack/ai-memory/-/ai-memory-0.2.11.tgz, `-0.2.13.tgz`, `-0.2.0.tgz`, `-0.1.11.tgz`.
- Source: https://github.com/TanStack/ai/tree/main/packages/ai-memory (`src/types.ts`, `src/middleware.ts`, `src/internal/store.ts`, `src/testkit/contract.ts`, `src/providers/*`).
- Changelog: https://github.com/TanStack/ai/blob/main/packages/ai-memory/CHANGELOG.md.
- Docs: https://github.com/TanStack/ai/tree/main/docs/memory (`overview.md`, `custom-adapter.md`, `operating.md`). Package skill: `skills/tanstack-ai-memory/SKILL.md` in the tarball.
- `@tanstack/ai` 0.66.0: `src/scope.ts`, `src/activities/chat/index.ts` (lines 1090 and 1494-1497), `src/activities/chat/middleware/types.ts` (lines 240-243 and 520-529).
- This repo: `packages/chat-sdk/core/server/chat/run.ts`, `packages/chat-sdk/core/server/chat/compaction.ts`, `docs/adr/0011-background-jobs-through-durable-runner.md`, `docs/adr/0013-memories-as-extracted-facts.md`.
