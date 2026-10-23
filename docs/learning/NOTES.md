# Teaching notes

## Learner preferences

- Wants "everything": change, review, explain and extend the chat feature. Starts from almost no code knowledge (2026-10-08).
- 2026-10-14: hadn't started the first course; asked to update the lessons for the new features and to learn everything current at a deeper level, so they can change the code on their own. Chose scope "Chat SDK + Host wiring" and "core path first" (8 lessons now, more as they finish).
- Workspace lives in `docs/learning/` so lessons can link straight to source files (relative `../../../packages/chat-sdk/...`).
- Follow `.claude/skills/teach/LESSON-STYLE.md`: ≤900 words, ≤4 sections, picture first, run `check-lesson.mjs`.

## Analogies that worked / in use

- (none tested yet with the learner; record here when one lands)

## Components (docs/learning/assets)

- `style.css`, `diagrams.js` (svg/box/arrow/route/text/dot), `explainer.js` (video), `quiz.js`, `exercise.js` (deep-equal ignores key order), `names.js` (NAMES + Names? button; emptied 2026-10-14 and refilled from the new lessons), `package-map.js` (PACKAGES, DEPS, clickable map; rewritten by Lesson 1 for the SDK).
- `message-tree.js`: `MessageTree.SAMPLE`, `byAge`, `layout`, `draw(nodes, { path, activeLeaf, fresh, tags })`, `render(selector, nodes, { onPick })` (Lessons 7, 8).

## Course (rebuilt 2026-10-14; index at `index.html`)

Old Lessons 1–14 (2026-10-08) are in `lessons/archive-2026-10-08/`; most of their source links are dead.
Lessons 1–8 (the assistant) moved to `lessons/archive-2026-10-23/` when the assistant went (ADR 0027); the course now starts at Lesson 9.

Batch 1 (built 2026-10-14): 1 Host and SDK · 2 createChat · 3 the command · 4 handleChat · 5 the Run and its log · 6 runs outlive the client · 7 Message tree · 8 Branches.

Planned (index shows them grey): parts boundary · system prompts and context · tools in a Run · Approval · web search/fetch and Sources · credentials and keyring · Host credentials/Quota/usage · rate limits and moderation · Attachments and blob store · Generated images · Artifacts · Projects and Knowledge · background jobs · Synced sources · Memory · Temporary Conversations · Shared links · titles and Background Model · oRPC routers and error codes · Host hooks and Admin · client and ui/ layers · testing seams.

Next steps: follow the learner through batch 1; write learning records from quiz results and questions; build batch 2 adapted to what they found hard; add review drills (spot the bug in a fake PR diff) as spaced practice; build a glossary reference once terms are understood.

## Code findings surfaced while writing lessons

Batch 1 (2026-10-14), worth turning into review drills or ADR follow-ups:

- ADR 0001 says Messages are "never mutated once written", but `rateMessage` (store.ts) sets `rating`/`ratedAt` on ended replies, and `approval.ts` sets a reply's `parts`/`status` back to `streaming` for the next Run. `parentId` never changes, which is what ADR 0004 needs. Lesson 7 says "Messages never move".
- ADR 0002's Consequences still describe the in-process registry, the boot sweep and 1 s polling; its header says ADR 0006 amended it, and the code matches ADR 0006.
- ADR 0006 lists "does `resumeServerSentEventsResponse` accept our own `StreamDurability`?" as open; the code now does exactly that.
- The old finding "Stop across two processes loses the stop" no longer holds: the final save uses `write(..., { whileStreaming: true })`. Stop works across processes even on `memoryRuntime` (through `cancel_requested_at`, ~1 s late); join across processes does not (empty stream).
- Two refusal bodies break `{ code, params }`: quota (402, `quota_exceeded`) and moderation (422, `{ message, code: "moderated", reason }`).
- `error.messageTooLong` is checked after the Host's `moderate` hook, so `moderate` can run on a Message then refused for size.
- The browser does POST a `messages` list (`useChat` always adds it) and `data` repeats `forwardedProps`; the server reads only `forwardedProps`. "Never sends the history" means "never trusts it".
- `apps/web/scripts/migrate.ts` imports `migrate` from `core/server/migrate.ts` directly instead of `chat.migrate()`, because it also migrates Better Auth and drops the old `public` chat tables.
- Only `POST /run` checks `lifecycle.stopping`; joins and RPCs keep working during the drain.
- ADR 0005 says "the client never imports the server"; client and ui do, but only with `import type` (chat-client.ts, search.ts, chat-view.tsx, archived-conversations.tsx, conversation-panel.tsx). ADR 0005 also still says `keyEncryptionSecret` (singular); the code takes `keyEncryptionSecrets` (ADR 0010).
- `scripts/copy.ts` keeps `extras/` on later copies as well as `ui/`; the README mentions only `ui/`. The SDK's package.json lists `@ai-chat/db`, but only tests and the memory eval import it.
- `package-map.js` (rewritten for the SDK) adds `TYPE_ONLY` (dashed edges), `select(id, opts)` and `draw(id, { probe: { from, to, ok, typeOnly } })`.
