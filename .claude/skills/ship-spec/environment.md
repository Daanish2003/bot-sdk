# Environment: this machine's gotchas

Shared by the orchestrator and every implementer. Each bullet cost a past run a retry. Add new ones at the end of a run, in the section they belong to (SKILL.md step 5), and delete any that a run proves wrong.

## Worktrees and git

- **Worktree paths:** ticket worktrees go in `../ai-chat-wt/<N>`, and the integration worktree in `../ai-chat-wt/integration-<spec>` (old runs leave undeletable folders behind, so a fixed name collides). Always pass agents **absolute** paths; a relative path once created a stray `hobby/hobby/`.
- **Line endings:** create every worktree with `git -c core.autocrlf=false worktree add …`. The Windows system gitconfig sets `autocrlf=true`, and a CRLF worktree fails `oxfmt --check` on every file. Check for real changes with `git diff --ignore-cr-at-eol`.
- **Merges too:** pass `-c core.autocrlf=false` to every `git merge` and `checkout` in a worktree. A plain merge once checked out 617 files with CRLF. To recover, delete those files and run `git -c core.autocrlf=false restore -- .`.
- **Stale-stat files block a merge:** after a CRLF repair, git can call identical files "local changes" and refuse the merge (17 files in the #587 run). Check that each file is really unchanged (`git hash-object --no-filters <file>` equals `git rev-parse HEAD:<file>`), then run `git -c core.autocrlf=false checkout HEAD -- <files>`.
- **Removing a worktree:** `git worktree remove` can fail on "Filename too long" (deep `node_modules`). It still deregisters the worktree, but the folder stays. Once the user has asked for it gone, `node -e "require('fs').rmSync('<abs path>',{recursive:true,force:true})"` removes it (long paths are fine) for one folder; `cmd rd` and PowerShell failed on the escaping from Git Bash in the #531 run. A bulk removal of many folders was denied even after the user asked, so write the loop to a script in `%TEMP%` and give the user `! node <script>`. Sometimes it only marks the worktree `prunable`; run `git worktree prune` before `git branch -d`.
- **Creation order:** create worktrees one at a time. Parallel `git worktree add` races on the `.git/config` lock.
- **Pre-made worktrees:** never give `isolation: "worktree"` to an agent that has one; it gets a second worktree under `.claude/worktrees` and its git commands on yours are refused.
- **What hooks block:** `git branch -D`, `git checkout -- .`, `reset --hard`, force-push and pushing to `main`. Use `git branch -d`, and to clear CRLF-only noise, use `git add -A`. Give the user `-D` commands to run. The hooks match the text anywhere in a command, even inside a sed or echo string, so write "force-delete" instead.
- **`-d` and ticket branches:** `git branch -d` checks against the current branch's upstream or HEAD, so it refuses a ticket branch that is merged only into the integration branch. Put those branches on the user's list at the end.
- **Formatting:** `pnpm check` runs `oxfmt --write` and rewrites line endings in every file. Use `pnpm exec oxlint` and `pnpm exec oxfmt --check` instead.
- **Scripted edits:** this machine has no `python`; use `node -e`.
- **Fresh worktrees:** the first `pnpm exec` in a worktree with no `node_modules` runs a `pnpm install`. Two at once can fail with `ERR_PNPM_LOCKFILE_RENAME_FILE`; retry once the install has finished.

## Databases and services

- **Postgres:** port 5435 (5432 is another project's). Use `127.0.0.1`, never `localhost`: Node tries `::1` first and Docker's IPv6 forwarding hangs the handshake. The image must be `pgvector/pgvector:0.8.7-pg18-trixie`.
- **Test databases:** one per ticket, `TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_test_<N>`. The integration verify uses its own database (`ai-chat_test_int_<spec>`); a shared one breaks once one branch's migration has run on it. Drop the run's test databases at the end. Each run copies the migrated database once per vitest worker (`<database>_r<runId>_w<n>`) and drops only its own copies when it ends, so concurrent runs on one database don't collide. A run killed midway leaves its copies behind for good; the end-of-run drop below removes them.
- **Redis:** 6379 is another project's and needs auth. Tests use ai-chat's compose Redis, `ai-chat-redis`, on `127.0.0.1:6380`, with one database number per ticket (`TEST_REDIS_URL=redis://127.0.0.1:6380/<1–15>`). The integration verify uses 0.
- **Starting the services:** from the **main checkout**, never a worktree, run `docker compose --env-file apps/web/.env up -d postgres redis`. `apps/web/.env` sets `POSTGRES_PORT=5435` and `REDIS_PORT=6380`. A plain `docker compose up -d redis` recreated Redis on 6379, and verify then failed with 34 timeouts (#543 run).
- **Memory:** this is a 16 GB machine. Run only one heavy job at a time (a verify, an e2e run, or an agent's suite). Hundreds of leftover test databases once made Postgres hold 2.4 GB and got e2e killed. At the end of the run, drop every `ai-chat_test%` and `ai-chat_e2e%` database except `ai-chat`. The editor's tsserver (a child of typescript-language-server) can hold 2–3 GB (3.2 GB in the #463 run) and once got a verify reaped. When memory is low, `taskkill` it; the editor restarts it. The classifier denies that kill ("Interfere With Workloads") unless the user has said to free memory, and after the denial it also refused the next verify; ask the user first. An agent's e2e run was killed for low memory in the #486 run, so the orchestrator runs e2e for the slot holder.
- **Dropping databases:** an implementer in the #510 run dropped every `ai-chat_test%` database, the integration verify's included. Brief each agent to drop only its own database by its exact name; only the orchestrator runs the end-of-run sweep.
- **`pnpm check-types` in a worktree** fails on varlock ("config is invalid") because there is no `.env`. Export verify.sh's placeholder env first.
- **`.env`:** never copy the user's `.env` into a worktree. Tests and builds get CI's placeholder values (verify.sh carries them).
- **Local E2B Embed** (WSL `Ubuntu-24.04`, `~/e2b`): a template build uploads to `[::1]:5008`, which Node can't reach from Windows. Run a small TCP relay from `127.0.0.1:5008` to `[::1]:5008` during the build. When a build fails with "envd syncing" or an mmap memfd error, drop the page cache as root (`wsl -d Ubuntu-24.04 -u root -- bash -c 'sync; echo 3 > /proc/sys/vm/drop_caches'`) and rebuild.
- **Embed and memory:** the Embed distro holds several GB. Stop it (`wsl --terminate Ubuntu-24.04`) before a verify or an e2e run. In the #587 run, both were reaped for low memory until the distro and tsserver were stopped. Restart it with `wsl -d Ubuntu-24.04 -- bash -c 'cd ~/e2b && docker compose up -d --wait'`.
- **Concurrent evals:** give each eval run its own `EVAL_DATABASE_URL` database (for example `ai-chat_eval_ladder`). Two evals on one database truncate each other's rows.

## Checks

- **Where vitest runs:** always from the **repo root**. From a package, it skips the root `globalSetup`, and tests fail with "database does not exist".
- **Integration files run in parallel**, one database copy per worker, with the module graph shared per worker (`isolate: false`). A file that calls `vi.mock` runs in the `integration-mocked` project instead (vitest.config.ts finds them). Other global state a file changes (fake timers, stubbed globals, env) must be restored by that file.
- **Read the exit code**, not only the summary. Vitest exits 1 on unhandled errors while every test passes. Also read the **skip count**: turbo's strict env drops variables missing from `passThroughEnv`, and the suites gated on them skip silently.
- **Runs stay in the foreground:** agents hand back with background runs still going, and those runs die with them. Stop an old verify (TaskStop) before starting a new one.
- **Timestamps:** tests that compare a Postgres-default timestamp (the Docker clock) with a JS one (the host clock) are flaky. Set timestamps explicitly. Test helpers that insert rows count too: `insertMessage` let `created_at` default to the Docker clock, which drifts from the host by seconds, and 5 tests failed on main (#510 run). Never hard-code "today" in a test either: a Bot list test dated 2026-10-17 broke once the real clock passed it.
- **Work that outlives a test:** a Run stopped mid-tool-call ends before the tool's write, so a test that returns then leaves a transaction that can deadlock the next file's `truncateAllTables` (CI on #495). A test that stops a Run must await the stopped write. Local runs rarely show it; 4 parallel `--repeats 400` loops did. A test that reads one event of `bot.send` and moves on leaves a server-side follower that queries on the next hint and deadlocks the truncate the same way (#510): close the stream and wait for the open-subscription count to drop.
- **CI is the last check:** CI's `check` failed on #495 after every local verify passed. Report the CI result before asking the user to merge.
- **Verify time:** about 3–7 minutes since #454 (3 minutes in the #463 run). A much longer run means memory pressure or leftover databases.
- **Verify under load:** a verify that runs while implementers run their own suites can fail on timeouts. In the #587 run, with 3 agents testing, 3 `bot-computer` and `bot-send` tests timed out, and both files passed alone (109/109). Before treating such a failure as real, re-run the failing files alone. Run the verify that gates the PR when no agent is testing.
- **generate-image flake:** `generate-image.integration.test.ts` ("records the flat price … for a stopped call") failed once in the #587 final verify under full-suite load and passed alone 3/3.
- **Large commits:** the lint-staged pre-commit hook fails with "command line too long" at about 150 or more files. Split a wide move into several commits.
- **Node strip-types:** scripts run by Node directly (`copy.ts`, and what the example Host loads) can't use TypeScript parameter properties or enums.
- **Tailwind v4 `@source`:** a glob like `@source "../plugins/*/ui"` was not scanned. Name each folder, otherwise the e2e fails with unstyled screens.
- **e2e flakes:** two-factor, password-reset, knowledge and artifacts.phone have failed under `--workers=2` and passed when re-run alone. Re-run the failures with `--workers=1` before treating them as real. In CI, artifacts.phone has failed twice in one run (retry included) and passed on `gh run rerun <id> --failed` (again in the #531 run).
- **Code review by an agent:** a forked `code-review` can review the main checkout and see an empty diff. Point it at the worktree path. In the #543 run, forked reviews often never returned to the implementer, which then reported "0 findings (empty result)". The orchestrator's branch review covers it.
  In the #587 run, forked reviews also returned empty results or reviewed the wrong scope (the main checkout or the whole branch). Give the review the worktree path and the ticket's commit range.
- **Fresh worktrees have no `node_modules`:** a first `pnpm exec` in one stalled for 40 minutes on an install contended by parallel agents. Tell implementers to run `pnpm install --frozen-lockfile --prefer-offline` in the foreground first, which takes about 1 minute.
- **Killing a process:** give the user `! taskkill //PID <id> //T //F`. Git Bash needs the double slashes.
- **Heredocs in Bash:** backslashes inside a heredoc sent through the Bash tool were dropped (regexes and `
` in scripts). Write the script with the Write tool into the scratchpad and run it.
- **CI-only criteria:** a criterion like "green on PR" or "seen to fail in CI" needs a real PR. Use a draft PR into the integration branch.

## Slots

- **e2e:** Playwright's ports (3100, 3101, 11534) are fixed, so only one e2e run at a time. Run it from `apps/web` with both `E2E_DATABASE_URL` and `DATABASE_URL` set (`127.0.0.1:5435/ai-chat_e2e_<spec>`) and `--workers=2`. The webServer runs `pnpm build`, which needs `DATABASE_URL`. Whoever holds the slot runs the whole e2e suite, not just their own spec.
- **Migrations:** only one ticket at a time adds a migration. The SDK's migrator applies only migrations newer than the last one applied, so the dates must stay in merge order:
  - When merging, regenerate the later ticket's migration with drizzle-kit on top of the merged branch, then re-date it. Never hand-edit snapshot `prevIds`.
  - Update `LATEST_MIGRATION` and the migrate test's count.
  - Check: `pnpm exec drizzle-kit generate` in the SDK package must say "No schema changes".
  - **Two specs in parallel:** merge the spec with the earlier-dated migrations first. The other spec then merges main into its branch. drizzle-kit 1.0 rc reads the two snapshot chains as commuting branches: generate says "No schema changes", check says "Everything's fine", and no snapshot edit is needed. After steps 5 and 4, #561 merged before #583.
  - **Shared course numbering:** two specs can write the same lesson number. The spec that merges second renumbers its lesson file, the nav links, `names.js` `lesson:` and `data-upto`, and the later `counter-reset` values in `docs/learning/index.html`.
  - drizzle-kit writes `snapshot.json` in a shape that `oxfmt --check` can refuse. Run `pnpm exec oxfmt` on the new snapshot before committing.
- **SDK copy:** after a merge that touches the SDK, run the copy into the example Host visibly, never piped to `/dev/null`, and with an absolute destination: `node scripts/copy.ts <absolute dest>` from `packages/bot-sdk`. `pnpm run copy -- <dest>` passes `--` as the destination and creates a stray `packages/bot-sdk/--` folder. Confirm with `diff -rq --strip-trailing-cr` that only `VERSION` differs. A `VERSION` conflict is only a timestamp, and CI's drift check skips it. Resolve it by writing one side's file with `git show <branch>:<path> > <path>`. A commit whose only lint-staged file is `VERSION` fails, because oxfmt says "Expected at least one target file".
- **Copy script gaps:** `copy.ts` never refreshes `extras/` once it exists and never removes a dropped plugin folder, and `ui/` is Host-owned after the first copy. Diff `extras/` by hand after a copy (the #486 run found a stale Trigger.dev import there).

## Evals

- **The batching case in `eval:turn` is timing-sensitive:** it depends on how messages land between Model calls, and it went from failing to 9/10 only after the #603 harness fix. Compare it A/B against main before calling a change a regression.
- **Embed slow resume:** after a resume with an open Screen, Chrome's CDP took 5–52 s. Twice in 5 lifecycle runs, the Embed proxy then reset the first live-view connections (ECONNRESET). Re-run the lifecycle eval before treating that as real.

## Permissions

- **Real-Model evals:** implementers have no Model key, and reading the user's `.env` with grep or cat is denied. The orchestrator runs the real-Model eval only after the user agrees to it. In the #510 run, the user allowed sourcing `apps/web/.env`, which holds their OpenRouter key; the root `.env` has no key. The eval judge takes an `openrouter:` Model. Leave the eval ticket open until that run is done.
- **Agent API errors:** an implementer can die mid-run on a network error (ENOTFOUND). SendMessage to the same agent resumes it with its context intact.
- **Merging PRs:** auto mode blocks `gh pr merge` on an unreviewed PR, so the user merges. When the user says "merge it" explicitly, `gh pr merge <n> --merge` goes through (#561 and #583).
- **Long paths:** `git worktree remove --force` failed with "Filename too long" on a worktree with `node_modules`. It unregistered the worktree but left the folder. `node -e 'require("fs").rmSync(<dir>,{recursive:true,force:true})'` removed it.
- **Haiku denials:** the classifier has denied Haiku agents a Playwright run and edits to `package.json`. The orchestrator runs e2e itself when asked, and dependency changes are owner decisions anyway.
- **Worktree removal can hang:** `git worktree remove` on a worktree whose agent left a background process ran past the 2-minute Bash timeout. Wrap it in `timeout 100` or run it in the background.
- **Removing folders:** the classifier denies `rm -rf` of worktree folders, and also denied a cleanup script. Give the user one short `!` command per folder.
