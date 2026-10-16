---
name: workflow
description: "Which skill to use next: the path from idea to merged PR."
disable-model-invocation: true
---

Tell the user which skill fits their situation, using the map below. Recommend one next step, not the whole list. The `mattpocock-skills:` skills come from the user-level plugin; `/pr` lives in this repo.

## Idea → merged PR (the main path)

1. **`/mattpocock-skills:grill-with-docs`**: interview until the idea is unambiguous; updates `CONTEXT.md` and records decisions in `docs/adr/`. Start here for anything bigger than a one-line fix.
   Too big for one session, or the route is still foggy (a new product area, a migration, a vendor choice)? **`/mattpocock-skills:wayfinder`** instead: it charts the open decisions as a map of issues and resolves one per session.
2. Is there a question only running code can answer (a state model, a UI)? **`prototype`** it first, in a separate session; bring back the verdict.
3. More than one session of work? **`/mattpocock-skills:to-spec`**, then **`/mattpocock-skills:to-tickets`** (vertical-slice tickets with blocking edges). Keep steps 1–3 in one context window.
4. Per ticket, in a fresh session (`/clear`) and its own branch: **`/mattpocock-skills:implement`**. It drives `tdd` and ends with `code-review`.
5. **`/pr`**: push, open the PR, wait for CI on that commit. A human reviews and merges.

Small, clear change? Skip to `implement` (or just `tdd`) in the current session.

A whole spec's tickets at once? **`/ship-spec <spec>`** instead of steps 4–5: parallel implementers in worktrees, a model picked per ticket, merged into one `feature/<spec-slug>` branch, then one PR to main.

## Other situations

- Something is broken, flaky or slow: **`diagnosing-bugs`** (no fix before a repro that goes red).
- Review a branch or PR: **`code-review`**.
- Merge or rebase conflict: **`resolving-merge-conflicts`**.
- A manual setup a human must do (secrets, dashboards, a cutover): **`wizard`**.
- The code is getting hard to change: **`/mattpocock-skills:improve-codebase-architecture`**.
- Ending a session mid-work: **`/mattpocock-skills:handoff`**.
- A fact from outside the repo (vendor API, pricing, a standard): **`research`**.
- Writing or editing a skill, `AGENTS.md` or a rule: **`writing-for-agents`**.
