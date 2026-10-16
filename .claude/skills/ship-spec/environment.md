# Environment: this machine's gotchas

Shared by the orchestrator and every implementer. Each bullet cost a past run a retry. Add new ones at the end of a run, in the section they belong to (SKILL.md step 5), and delete any that a run proves wrong.

## Worktrees and git

- **Worktree paths:** ticket worktrees go in `../ai-chat-wt/<N>`, and the integration worktree in `../ai-chat-wt/integration`. Always pass agents **absolute** paths; a relative path once created a stray `hobby/hobby/`.
- **Line endings:** create every worktree with `git -c core.autocrlf=false worktree add …`. The Windows system gitconfig sets `autocrlf=true`, and a CRLF worktree fails `oxfmt --check` on every file. Check for real changes with `git diff --ignore-cr-at-eol`.
- **Merges too:** pass `-c core.autocrlf=false` to every `git merge` and `checkout` in a worktree. A plain merge once checked out 617 files with CRLF. To recover, delete those files and run `git -c core.autocrlf=false restore -- .`.
- **Removing a worktree:** `git worktree remove` can fail on "Filename too long" (deep `node_modules`). It still deregisters the worktree, but the folder stays and needs the user to remove it.
- **Creation order:** create worktrees one at a time. Parallel `git worktree add` races on the `.git/config` lock.
- **Pre-made worktrees:** never give `isolation: "worktree"` to an agent that has one; it gets a second worktree under `.claude/worktrees` and its git commands on yours are refused.
- **What hooks block:** `git branch -D`, `git checkout -- .`, `reset --hard`, force-push and pushing to `main`. Use `git branch -d`, and to clear CRLF-only noise, use `git add -A`. Give the user `-D` commands to run. The hooks match the text anywhere in a command, even inside a sed or echo string, so write "force-delete" instead.
- **`-d` and ticket branches:** `git branch -d` checks against the current branch's upstream or HEAD, so it refuses a ticket branch that is merged only into the integration branch. Put those branches on the user's list at the end.
- **Formatting:** `pnpm check` runs `oxfmt --write` and rewrites line endings in every file. Use `pnpm exec oxlint` and `pnpm exec oxfmt --check` instead.

## Databases and services

- **Postgres:** port 5435 (5432 is another project's). Use `127.0.0.1`, never `localhost`: Node tries `::1` first and Docker's IPv6 forwarding hangs the handshake. The image must be `pgvector/pgvector:0.8.7-pg18-trixie`.
- **Test databases:** one per ticket, `TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_test_<N>`. The integration verify uses its own database (`ai-chat_test_int_<spec>`); a shared one breaks once one branch's migration has run on it. Drop the run's test databases at the end. Each run copies the migrated database once per vitest worker (`<database>_r<runId>_w<n>`) and drops only its own copies when it ends, so concurrent runs on one database don't collide. A run killed midway leaves its copies behind for good; the end-of-run drop below removes them.
- **Redis:** 6379 is another project's and needs auth. Tests use ai-chat's compose Redis, `ai-chat-redis`, on `127.0.0.1:6380`, with one database number per ticket (`TEST_REDIS_URL=redis://127.0.0.1:6380/<1–15>`). The integration verify uses 0.
- **Starting the services:** `pnpm db:start` for Postgres (`ai-chat-postgres`) and `docker compose up -d redis` for Redis. Run both from the **main checkout**, never a worktree: the gitignored root `.env` there sets `POSTGRES_PORT=5435` and `REDIS_PORT=6380`, and a worktree has no `.env`, so it would publish on the wrong ports.
- **Memory:** this is a 16 GB machine. Run only one heavy job at a time (a verify, an e2e run, or an agent's suite). Hundreds of leftover test databases once made Postgres hold 2.4 GB and got e2e killed. At the end of the run, drop every `ai-chat_test%` and `ai-chat_e2e%` database except `ai-chat`. The editor's tsserver (a child of typescript-language-server) can hold 2 GB and once got a verify reaped. When memory is low, `taskkill` it; the editor restarts it.
- **`.env`:** never copy the user's `.env` into a worktree. Tests and builds get CI's placeholder values (verify.sh carries them).

## Checks

- **Where vitest runs:** always from the **repo root**. From a package, it skips the root `globalSetup`, and tests fail with "database does not exist".
- **Integration files run in parallel**, one database copy per worker, with the module graph shared per worker (`isolate: false`). A file that calls `vi.mock` runs in the `integration-mocked` project instead (vitest.config.ts finds them). Other global state a file changes (fake timers, stubbed globals, env) must be restored by that file.
- **Read the exit code**, not only the summary. Vitest exits 1 on unhandled errors while every test passes. Also read the **skip count**: turbo's strict env drops variables missing from `passThroughEnv`, and the suites gated on them skip silently.
- **Runs stay in the foreground:** agents hand back with background runs still going, and those runs die with them. Stop an old verify (TaskStop) before starting a new one.
- **Timestamps:** tests that compare a Postgres-default timestamp (the Docker clock) with a JS one (the host clock) are flaky. Set timestamps explicitly.
- **Verify time:** about 4–7 minutes since #454. A much longer run means memory pressure or leftover databases.
- **Large commits:** the lint-staged pre-commit hook fails with "command line too long" at about 150 or more files. Split a wide move into several commits.
- **Node strip-types:** scripts run by Node directly (`copy.ts`, and what the example Host loads) can't use TypeScript parameter properties or enums.
- **Tailwind v4 `@source`:** a glob like `@source "../plugins/*/ui"` was not scanned. Name each folder, otherwise the e2e fails with unstyled screens.
- **e2e flakes:** two-factor and artifacts.phone have failed under `--workers=2` and passed when re-run alone. Re-run the failures with `--workers=1` before treating them as real.
- **Code review by an agent:** a forked `code-review` can review the main checkout and see an empty diff. Point it at the worktree path.
- **CI-only criteria:** a criterion like "green on PR" or "seen to fail in CI" needs a real PR. Use a draft PR into the integration branch.

## Slots

- **e2e:** Playwright's ports (3100, 3101, 11534) are fixed, so only one e2e run at a time. Run it from `apps/web` with both `E2E_DATABASE_URL` and `DATABASE_URL` set (`127.0.0.1:5435/ai-chat_e2e_<spec>`) and `--workers=2`. The webServer runs `pnpm build`, which needs `DATABASE_URL`. Whoever holds the slot runs the whole e2e suite, not just their own spec.
- **Migrations:** only one ticket at a time adds a migration. The SDK's migrator applies only migrations newer than the last one applied, so the dates must stay in merge order:
  - When merging, regenerate the later ticket's migration with drizzle-kit on top of the merged branch, then re-date it. Never hand-edit snapshot `prevIds`.
  - Update `LATEST_MIGRATION` and the migrate test's count.
  - Check: `pnpm exec drizzle-kit generate` in the SDK package must say "No schema changes".
- **SDK copy:** after a merge that touches the SDK, run the copy into the example Host visibly, never piped to `/dev/null`, and with an absolute destination. Confirm with `diff -rq --strip-trailing-cr` that only `VERSION` differs. A `VERSION` conflict is only a timestamp; resolve it with `git checkout --ours`.

## Permissions

- **Merging PRs:** auto mode blocks `gh pr merge` on an unreviewed PR, so the user merges.
- **Haiku denials:** the classifier has denied Haiku agents a Playwright run and edits to `package.json`. The orchestrator runs e2e itself when asked, and dependency changes are owner decisions anyway.
- **Removing folders:** the classifier denies `rm -rf` of worktree folders, and also denied a cleanup script. Give the user one short `!` command per folder.
