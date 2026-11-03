# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Verify, Then Fix the Root Cause

- **Verify; never assert on faith.** Before stating that a file, function, config key, API or library behavior exists or works, confirm it: read the file, grep, or run it, and cite the path. Docs, comments and memory are leads to verify. If you cannot verify, say so.
- **Fix the root cause, everywhere.** When a defect has one cause in several places, fix every instance in the same change. If the real fix is large, name it and propose it instead of shipping only the surface patch.
- **Done means verified.** A test is only trusted once it has been seen to fail (break the behavior, watch it go red). A CI fix is done when the pushed commit's job is green for that SHA, not when it passes locally.
- **A red CI job needs a cause.** Rerun a failed job only after stating a cause from its log. A test that keeps failing, or passes only on its retry, is a possible product bug until shown otherwise; "flake" is a conclusion that needs evidence.
- **Run e2e locally** (`pnpm test:e2e`) when a PR changes behaviour a spec covers.
- **A PR's CI counts only against the latest `main`.** `main` requires `check` and `apps/web image and end-to-end` on an up-to-date branch. When `main` moves, merge it in and wait for CI on the new SHA.

## 6. Decision Rights

Some decisions belong to a human. Propose them (an issue comment, a `proposed` ADR, the PR's _Decisions I made_) and stop for a yes, unless the approved spec or ticket already makes the decision:

- database schema and migrations (a `/ship-spec` run decides these provisionally, under its AFK rule)
- auth and permissions
- billing and payments
- public APIs and webhooks
- new dependencies, infrastructure and deployment
- deleting data

Never build on an ADR whose `Status:` is `proposed`.

## 7. Workflow

Idea → grill → spec → tickets → per ticket, fresh session: implement (test-first, ends with a review) → `/pr` → human review and merge. `/workflow` says which skill fits any situation.

- One ticket per session and per branch (`<type>/<issue>-<slug>`); `/clear` between tickets.
- **After a PR merges**, clean up before anything else: `git switch main && git pull --ff-only`, then delete the branch locally (`git branch -d <branch>`) and on GitHub (`git push origin --delete <branch>`), then `git fetch --prune`. `-d` refuses a squash-merged branch; confirm the PR is merged (`gh pr view <n> --json state`) and ask the user to run `git branch -D <branch>`.
- Domain language: `CONTEXT.md`. Decisions: `docs/adr/` (read the ones touching your area; don't silently contradict one).
- `pnpm` only; never npm, npx, yarn or bun.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
