# Run brief: spec #<SPEC>

You are an **implementer** for one ticket of [spec #<SPEC>](https://github.com/Daanish2003/bot-sdk/issues/<SPEC>). Your prompt gives you the ticket URL and your worktree. Work only in that worktree; the orchestrator merges, pushes and closes. You do none of those.

- Integration branch: `feature/<SLUG>`
- Migration slot holder: <TICKET or none>. Only that ticket may add a migration.
- e2e slot holder: <TICKET or none>. Only that ticket may run Playwright.
- Your test database: `ai-chat_test_<N>`, where `<N>` is your ticket number. Your e2e database, when you run Playwright: `ai-chat_e2e_<SPEC>_<N>`. Those two are the only databases you may drop, and only by their exact names. Never drop by pattern (`LIKE`, a loop over `pg_database`): other tickets and the integration verify use databases on the same server.
- Machine gotchas: `.claude/skills/ship-spec/environment.md`. Read it first.

## Steps

1. **Check your base.** `git merge-base --is-ancestor <your HEAD> origin/feature/<SLUG>` must hold; if it doesn't, reset onto `origin/feature/<SLUG>` before any work.
2. **Read the ticket**: `gh issue view <N>`, with its comments. State its title. Read the spec's sections that the ticket links, `CONTEXT.md`, and the ADRs in `docs/adr/` that touch your area. Use the glossary's words in code and commits.
3. **Build it test-first.** Call the Skill tool with `tdd` at the seams the spec's Testing Decisions name, and prefer the highest existing seam. A test counts only once you've seen it go **red**. Reach for other skills when their trigger fits:
   - `codebase-design` when you're placing a seam or shaping a module's interface;
   - `diagnosing-bugs` when something fails and you don't know why;
   - `domain-modeling` when a new term appears.
4. **Check as you go.** Typecheck the packages you touched, run the affected test files, then `pnpm exec oxlint` and `pnpm exec oxfmt --check` on your changed files. Don't run the whole vitest suite; the orchestrator's verify is the full run. Run every command in the foreground and wait for it to exit.
   - In `packages/botsdk` sources, write no constructor parameter properties (`constructor(readonly x: string)`), `enum`, `namespace` or `import x = require`. The `botsdk` CLI runs these sources with Node's type stripping, which refuses them; declare the field and assign it in the constructor.
   - Back up work with a WIP commit, never by copying files.
5. **Review. This step is required, even for a small diff.** Call the Skill tool with `code-review` on your diff against `origin/feature/<SLUG>` (or `<base SHA>..HEAD` when your prompt names an unpushed base), pointing it at your worktree path, and fix every confirmed finding. If the review returns empty or reviews the wrong range, run it again; a self-review does not count. List it under `checks` in your report (`code-review → <n> findings, <n> fixed`). A report without it is sent back.
6. **Commit** with Conventional Commits naming the ticket, `(#<N>)`, ending with the attribution line from your instructions. After your last commit (and again after step 7), run root `pnpm check-types` and read its exit code. Report that run, not an earlier one; vitest doesn't typecheck.
7. **Take the tip.** Merge `origin/feature/<SLUG>` into your branch, resolve conflicts keeping both tickets' behaviour, and re-run step 4's checks.
8. **Report** in this shape, and nothing else:

   ```
   status: done | owner-decision | blocked
   ticket: #<N>
   base: <SHA of the integration tip you merged>
   commits: <SHA> <subject>, …
   checks: <command> → <result>, …
   acceptance: each criterion → met | not met (why)
   question: <only for owner-decision: one question, your recommended answer, and the options>
   provisional: <each open behaviour you chose: the question, your choice, what you rejected; or "none">
   notes: <anything the orchestrator must know at merge, or "none">
   ```

## Stop and report

The owner is away, and only the orchestrator talks to them.

- **Open behaviour or schema choice:** when the spec leaves a behaviour outside AGENTS.md §6 open and a later commit can change it, or leaves a schema or migration choice open, take the option you'd recommend, closest to the spec's user stories, keep building, and list it under `provisional`. A migration that removes or rewrites existing data, or decides auth or permissions, is an owner decision.
- **Owner decisions** (AGENTS.md §6) that the spec and ticket don't already settle: a new dependency, auth, billing, a public API, deleting data. Also cutting scope or an acceptance criterion, and a real-Model eval or other paid call. Stop before making the change and report `owner-decision`.
- **A permission denial:** report `blocked` with the exact command. Don't retry it in another form.
- **Running out of room before done:** write a handoff to `%TEMP%/ai-chat-handoff-<N>.md` with:
  - what's done, as commit SHAs;
  - what's left, against the acceptance criteria;
  - the failing check, if any;
  - a "suggested skills" section;

  Link the spec, ticket and commits instead of restating them. Then report `blocked`, giving that path.
