# Mission: The ai-chat Chat SDK, end to end

## Why

Agents wrote most of the chat feature. The goal is to own it end to end: to change it, review AI-written PRs against it, explain and defend its design, and extend it with new features and ADRs without needing an agent to explain the code first. Since October 2026 the feature is the Chat SDK (`packages/chat-sdk`), and `apps/web` is one Host that embeds it.

## Success looks like

- Trace one sent Message from the composer through `POST /api/chat/run`, `handleChat`, the Run, Postgres and the run log, and back to the screen, naming the file at each step.
- Explain the Message tree (Branches, Active Branch, edit, regenerate) and the ADRs from memory, including what each one rules out.
- Explain how a Host wires the SDK (`createChat` options, `migrate`/`start`/`stop`, hooks) and what the SDK never knows about the Host.
- Review a PR and catch boundary mistakes: code in `core/` that imports the Host, history sent from the client, a write before a check, a mutated Message.
- Make a real change to the chat feature (for example a new Message part, a new tool or a new run guard) with tests, unaided.

## Constraints

- Starts from almost no knowledge of the code (October 2026). The first course (Lessons 1–14, 2026-10-08) was never taken, and the code moved under it, so it was archived.
- Short lessons: about 10–15 minutes each, pictures first (see `.claude/skills/teach/LESSON-STYLE.md`).
- Ground truth is the repo itself: code, `CONTEXT.md` and `docs/adr/`.
- Lessons come in batches: a core path first, then more as the learner finishes them.

## Out of scope

- Better Auth and Passkey internals beyond "who is the user" (`getUser`).
- UI styling, shadcn and the generic `@ai-chat/ui` components; the PWA and i18n wording.
- Deployment and Redis operations beyond what a Run needs from them.
