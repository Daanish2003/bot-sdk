---
Status: accepted
---

# Memories are facts extracted after a Run, behind @tanstack/ai-memory

After each Run, the durable runner (ADR 0011) asks the Background Model to pull candidate facts from the new Messages, finds the most similar existing Memories with pgvector, and has one structured call decide to add, update, delete or leave each one (the Mem0 approach). An outdated Memory is marked invalid rather than deleted, so its history stays. Before a Run, a short profile of top Memories goes into the context, more are found by similarity, and the assistant can call `search_past_chats` over the Conversation history.

`packages/memory` is a Postgres adapter for `@tanstack/ai-memory`'s `recall`/`save` interface, so the Chat SDK wires it in like any other TanStack middleware.

## Considered Options

- **The Model edits its own memory with tools mid-reply** (Letta/MemGPT, Claude's memory tool): adds latency to every reply, and Claude's tool works with Anthropic models only.
- **A temporal knowledge graph** (Zep/Graphiti, Mem0g): about 1.5 points better on LoCoMo for a graph database and an extra LLM call per write.
- **Pass the whole history every time**: the most accurate on LoCoMo, at roughly 10× the tokens and latency.

Published benchmarks (LoCoMo, LongMemEval) are disputed between vendors, so this choice rests on cost and simplicity more than on scores. We should build a small eval of our own before changing it.

## Consequences

- Schema changes: a Memory table with an embedding column, which needs the `pgvector` extension.
- A new dependency on `@tanstack/ai-memory`.
- Making Memories costs a Background Model call per Run, counted against the Quota on Host credentials.
