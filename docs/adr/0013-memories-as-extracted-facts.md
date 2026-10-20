---
Status: superseded by ADR 0022
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

## Amendment: no @tanstack/ai-memory; Memory lives in the Chat SDK core (2026-10-12, #221)

Research ([#216](https://github.com/Daanish2003/ai-chat/issues/216), `docs/research/tanstack-ai-memory.md`) found that `@tanstack/ai-memory` gives us little. Its `save` runs inside `chat()` and holds the Run open, it sees only the reply's text with no ids, it scopes memory per thread, and every release works with exactly one `@tanstack/ai` minor. Extraction, ranking, profiles and scoping would all be ours anyway.

- **No dependency, no middleware.** Recall happens in `systemPromptsFor`, beside Instructions, before `chat()`. The Memory job is enqueued from the Run-end hook that already fires titling.
- **In core.** The code lives in `core/server/memory/`, not `packages/memory`, for the reason the runner moved there (ADR 0011's amendment, ADR 0005).
- **`createChat({ memory?: boolean })`**, on by default, switches Memory off for a whole Host.

## Amendment: how Memories are made and recalled (2026-10-12, #222–#227)

- **Mem0's two calls stay**, although Mem0 itself moved to only adding facts in 2026-04 ([#217](https://github.com/Daanish2003/ai-chat/issues/217)): that approach is weakest at knowledge updates, and the profile needs a clean set of current facts. The prompts are ported from Mem0 (Apache-2.0), not the package. The decide call sees the top 5 similar Memories in the same scope. An update marks the old Memory invalid and inserts a new one.
- **Scope comes from the Conversation.** A Memory has no Project of its own: it's in its Conversation's current Project, or general. A candidate is only ever compared with Memories in its own scope, so a fact said in a Project never invalidates a general Memory.
- **Facts come from the user's words.** The job reads the Run's user Message and reply, plus two earlier Messages for context, after Runs that end `complete` or `stopped`. It uses the Background Model or the Host's default, never the reply's Model.
- **"Forget X" removes.** An outdated Memory is marked invalid; one the user deletes, or asks the assistant to forget, is deleted. "Remember X" and "forget X" go through the same job, with no tool.
- **Recall:** a profile of the 20 newest valid Memories plus the top 10 by similarity to the latest user Message, after Instructions, which win on conflict. With 30 or fewer Memories in scope, all are included and nothing is embedded.
- **The eval** is a hand-run LongMemEval script of 40 cases in `packages/chat-sdk/eval/memory/`, outside CI.

Consequence updated: there is no new dependency on `@tanstack/ai-memory`. New schema: `chat.memory`, `user_settings.memory_enabled`, `conversation.temporary`, and `title_model` renamed `background_model`.

## Amendment: a `memory` plugin, and Bots keep files (2026-10-20, #616, #622)

- **A plugin.** Memory moves out of the assistant into a `memory` plugin, without changing how it works. The plugin requires `models` and `runner`. A Host turns Memory off by not installing the plugin, which replaces `memory?: boolean`. `memory_enabled` moves to `chat.memory_settings`, and the switch now covers Bots too. `background_model` stays in the assistant. `chat.memory` keeps its name.
- **Bots don't use this ADR.** A Bot's memory is plain files on its Computer (ADR 0022). The assistant keeps everything above, and its Memories are not shared with Bots' Profiles.

## Superseded: the assistant's Memories are removed (2026-10-20, #650)

The owner removed the assistant's Memory: only Bots remember, through their files (ADR 0022). Nothing saves, recalls, lists or re-embeds Memories, and the assistant's replies carry no "Memory updated" notice. A migration drops `chat.memory` with its embeddings and indexes, and the `memory_origin` enum, and deletes the queued `memory.make` and `memory.reembed` jobs; the Memories' data is deleted. The assistant Memory eval and its LongMemEval data go too. `chat.memory_settings`, the Memory switch, stays and now covers only Bots. `search_past_chats` stays: it searches Conversations, not Memories, and is still offered only with the switch on.
