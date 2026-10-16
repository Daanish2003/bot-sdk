# ai-chat Architecture Resources

## Knowledge

- [Repo: `CONTEXT.md`](../../CONTEXT.md)
  The domain glossary (Conversation, Message, Branch, Active Branch, Provider, Source, …). Use for: the exact word for every concept; lessons must match it.
- [Repo: `docs/adr/`](../adr/)
  Eighteen ADRs (0001–0018): the Message tree, Runs, credentials and the keyring, Shared links, the copied SDK, the run log and pub/sub, Host credentials and Quota, Approval, jobs, Synced sources, Knowledge, Memory, the blob store, Artifacts, the HTTP contract and webhooks. Use for: the "why" behind every design lesson.
- [Repo: `packages/chat-sdk/README.md`](../../packages/chat-sdk/README.md)
  How a Host adopts the SDK: the copy script, dependencies, Postgres extensions, the blob store, the Host lifecycle, hooks. Use for: every Host-wiring lesson.
- [Turborepo: Package and Task Graph](https://turborepo.com/docs/core-concepts/package-and-task-graph)
  Packages as a directed acyclic graph. Use for: package boundaries and why cycles break builds (Lesson 1). The installed copy is in `node_modules/.pnpm/turbo@*/node_modules/turbo/docs/`.
- [pnpm: Workspaces](https://pnpm.io/workspaces)
  The `workspace:*` protocol that links the packages. Use for: how `@ai-chat/*` imports resolve.
- [TanStack AI docs](https://tanstack.com/ai/latest/docs)
  `chat()`, adapters, `useChat`, stream chunks, SSE. Use for: the run and the client stream (pre-1.0, so check the installed version: `@tanstack/ai` 0.66.0, `@tanstack/ai-client` 0.39.0, `@tanstack/ai-react` 0.30.1 in `packages/chat-sdk/package.json`).
- [oRPC: Getting started](https://orpc.dev/docs/getting-started)
  Procedures, routers, the typed client. Use for: the `/api/chat/rpc/*` procedures in `core/server/routers/`.
- [Drizzle ORM](https://orm.drizzle.team/docs/overview)
  Schema, queries, transactions, `for("update")`. Use for: the tables and the send transaction.
- Installed `@tanstack/ai-client` 0.39.0: `node_modules/@tanstack/ai-client/dist/esm/connection-adapters.js` (`buildRunAgentInputBody`, `fetchServerSentEvents`)
  The ground truth for the POST body and `forwardedProps` (it follows the AG-UI protocol's `RunAgentInput`). Use for: Lesson 3.
- Installed `@tanstack/ai` 0.66.0: `dist/esm/stream-to-response.d.ts`
  Documents `resumeServerSentEventsResponse` and when a run can be joined. Use for: Lessons 5–6.
- [Postgres: row-level locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS) and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
  `SELECT … FOR UPDATE`, and why "read committed" lets the waiting send see the first send's reply. Use for: Lesson 4.
- Repo tests: `packages/chat-sdk/test/support/sdk.ts` (the test client's `fetch` is the handler) and `test/core/shared/chat/branches.test.ts` (the sample tree in `assets/message-tree.js`). Use for: Lessons 2, 7, 8.
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
  Use for: how the reply streams to the browser.
- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
  Use for: Stop and the run cap (ADR 0002).
- [TanStack Start overview](https://tanstack.com/router/latest/docs/framework/react/start/overview)
  Use for: the Host's catch-all route `apps/web/src/routes/api/chat/$.ts`.

## Wisdom (Communities)

- [TanStack Discord](https://tlinz.com/discord)
  The TanStack AI, Router and Query maintainers answer there. Use for: questions on `useChat` or `chat()` behaviour that the docs don't cover.
- Code review of real PRs in this repo is the main practice ground: review each agent PR against the lessons.

## Gaps

- No good external write-up on message trees for chat apps; the ADRs and code are the source.
