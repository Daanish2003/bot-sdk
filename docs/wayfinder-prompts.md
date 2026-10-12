# Wayfinder prompts

The seven Wayfinders planned on 2026-10-12, in order. Run them one at a time, with `/clear` between them. Each prompt carries the decisions already settled (in `CONTEXT.md` and ADRs 0011–0014), so the map doesn't ask them again. Type `/wayfinder` yourself as the very first thing in the message, then paste the rest of the prompt after it.

| #   | Wayfinder                    | Map                                                                           |
| --- | ---------------------------- | ----------------------------------------------------------------------------- |
| 1   | Platform before going live   | [#166](https://github.com/Daanish2003/ai-chat/issues/166), charted 2026-10-12 |
| 2   | Generated images             | not charted yet                                                               |
| 3   | Artifacts                    | not charted yet                                                               |
| 4   | Durable runner and Knowledge | not charted yet                                                               |
| 5   | Memory                       | not charted yet                                                               |
| 6   | Chat extras                  | not charted yet                                                               |
| 7   | SDK extensibility            | not charted yet                                                               |

To work through a map that's already charted, run `/wayfinder <map number>`. With no ticket named, it takes the next ticket on the frontier.

## 1. Platform before going live

Already charted as [Wayfinder: Platform before going live](https://github.com/Daanish2003/ai-chat/issues/166). To continue it, use `/wayfinder 166`. The original prompt:

```
/wayfinder Platform before going live (apps/web + Chat SDK), ahead of spec #94. Covers: (1) object storage, a file-storage interface in the SDK with Postgres as default and R2/S3 as an option, which Attachments move onto and later Knowledge files and Generated images use; (2) 2FA and passkeys through Better Auth's twoFactor and passkey plugins; (3) an admin view for the operator: users, usage per user, who hit their Quota, change a Quota, suspend a user (built on chat.usage); (4) thumbs up/down on assistant Messages. Read CONTEXT.md and ADRs 0007, 0009 (proposed), 0010 and 0011–0014. Note that ADR 0012 needs a persistent disk, which ADR 0009 must account for.
```

## 2. Generated images

```
/wayfinder Generated images in the Chat SDK. Settled: a generate_image tool the chat Model calls (no separate image mode); a per-user Image Model setting, picked from Providers whose TanStack AI adapter supports generateImage (OpenAI, Gemini, Grok, OpenRouter, Cloudflare, …); credentials follow the existing rule (the user's own Provider credentials first, otherwise Host credentials, priced per image against the Quota); shown inline in the reply with click-to-zoom and download; shown in Shared links, unlike Attachments; editing ("make it bluer") passes the previous Generated image back in; stored through the object-storage interface from the Platform map. Read CONTEXT.md (Generated image, Image Model, Attachment, Quota) and ADRs 0001, 0004, 0007.
```

## 3. Artifacts

```
/wayfinder Artifacts in the Chat SDK. Settled: the assistant calls create_artifact and update_artifact; each update is a numbered version, and the user can switch between versions; it opens in a side panel beside the chat; version 1 kinds are code, Markdown, HTML, SVG and Mermaid (React components later); the HTML preview runs in an iframe with sandbox="allow-scripts", no same-origin access and a strict CSP; Shared links show Artifacts read-only; the user can't edit an Artifact directly in v1. Open questions for the map: how Artifacts relate to Branches (does editing a Message fork an Artifact?), where they're stored, and how they appear in export and deleteUser. Read CONTEXT.md (Artifact, Branch, Shared link) and ADRs 0001, 0004, 0008.
```

## 4. Durable runner and Knowledge

[Where Synced source files live, given the disk limits](https://github.com/Daanish2003/ai-chat/issues/168) replaced the persistent disk with a local cache (ADR 0012, amended); the prompt below reflects that.

```
/wayfinder Durable runner and Project Knowledge. Settled by ADRs 0011, 0012 and 0014: (1) packages/durable-runner with enqueue, retries and status; the in-process runner (lease and reaper, as Runs use) is the default and Trigger.dev is opt-in; Runs stay on ADR 0006. (2) Knowledge belongs only to a Project. (3) Knowledge files are ported from Sim Studio (github.com/simstudioai/sim, Apache-2.0, with a NOTICE), and NOTHING is copied from ~/work/bcatalyst-platform. Formats are PDF (text layer only), DOCX, MD, TXT, CSV and HTML, with no OCR. There's one chunker. Search is pgvector plus Postgres full-text search fused by RRF, with no reranker. Embeddings use the user's OpenAI or Gemini Provider credentials, otherwise Host credentials, with one fixed embedding Model per Project's Knowledge. Each file shows a processing, ready or failed status. Answers cite Excerpts. (4) Synced sources, after Knowledge files: GitHub repos only (public, plus private through the user's connected GitHub account), synced on demand and daily (a sync records the commit; each searching process caches that commit locally and re-clones it on a miss, so no persistent disk; the per-source size limit and cache eviction are open for this map), and read with kb_shell/kb_shell_batch, adapted from the MIT shell-policy.ts in vercel-labs/knowledge-agent-template with its notice kept. Read CONTEXT.md (Knowledge, Knowledge file, Synced source, Excerpt, Project) and ADRs 0003, 0006, 0007, 0009, 0011, 0012, 0014.
```

## 5. Memory

```
/wayfinder Memory in the Chat SDK. Settled by ADR 0013: packages/memory is a Postgres + pgvector adapter for @tanstack/ai-memory (recall before a Run, save deferred after it). Making Memories runs on the durable runner (ADR 0011): the Background Model extracts candidate facts, the most similar existing Memories are found, and one structured call decides add, update, delete or leave each. Outdated Memories are marked invalid, not deleted. A Run gets a short profile always, more Memories retrieved by similarity, and a search_past_chats tool. Memories made in a Project stay in that Project; the rest are general. Controls: a Memory page in settings (view, edit, delete), "remember X" and "forget X" said in chat, each Memory linked to the Message it came from, and deleting a Conversation deletes its Memories (deleteUser and exportUser cover them too). A Temporary Conversation neither uses nor makes Memories, stays out of the sidebar and search, can't be shared, and is deleted 30 days after its last Message. The Title Model setting is renamed Background Model. Include a small LongMemEval-style eval. Read CONTEXT.md (Memory, Temporary Conversation, Background Model, Project, Instructions) and ADRs 0007, 0011, 0013.
```

## 6. Chat extras

Archiving was ruled out in [Projects and Conversation organisation](https://github.com/Daanish2003/ai-chat/issues/50) on the previous map. This map brings it back on purpose, so it should say why.

```
/wayfinder Chat extras in the Chat SDK: archiving Conversations (alongside pin and delete); saved prompts or / commands in the composer; Model compare (one prompt to two Models side by side, using sibling Branches); exporting one Conversation as Markdown or PDF; sampling settings (temperature and similar, per Conversation, next to reasoning effort); voice (speech-to-text in the composer, read-aloud on replies, via TanStack AI's generateSpeech and transcription); a sandboxed code-execution tool behind Approval. Prioritise within the map and say which ones are worth doing at all. Read CONTEXT.md (Conversation, Branch, Active Branch, Approval, Quota) and ADRs 0001, 0002, 0007, 0008.
```

## 7. SDK extensibility

```
/wayfinder SDK extensibility for Hosts embedding the Chat SDK (ADR 0005, a copied, stack-agnostic SDK): event hooks in createChat (onRunComplete, onUsage, onConversationCreated, …); a moderation hook that checks input and output around a Run; i18n of the SDK's UI strings; PWA support (manifest, service worker, mobile polish). Public API keys for users and outbound webhooks are public APIs under AGENTS.md §6: chart them only as proposed ADRs for the owner's yes, never as ready tickets. Read CONTEXT.md (Chat SDK, Host, Run) and ADRs 0005, 0006, 0007.
```
