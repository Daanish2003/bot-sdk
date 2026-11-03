---
name: pr
description: "Push the current branch, open a pull request, and wait for CI on that commit."
disable-model-invocation: true
---

Ship the current branch as a pull request. The work is not done until CI is green on the pushed commit.

1. **Check the branch.** Refuse on `main`. `git status` must be clean. Run `pnpm exec oxfmt --check`, `pnpm exec oxlint --deny-warnings` and `pnpm check-types`, plus `pnpm test:e2e` when the branch changes behaviour a spec covers; stop and report if any fails.

2. **Push.** `git push -u origin HEAD`. Never force-push a branch someone else may have pulled; if the push is rejected, stop and tell the user.

3. **Open the PR** with `gh pr create --base main`, the body in these sections:
   - **Summary** from the issue or spec, not a restatement of the diff. Link it (`Closes #42`).
   - **How it was tested**: the tests added, the command run, and what was seen to fail before the fix.
   - **Decisions I made**: every choice the issue or spec left open, from the session and the diff. Mark any on the human-only list in `AGENTS.md` (Decision rights) so the reviewer approves it explicitly. Say "none" only when true.
   - **Risk**: schema changes, auth, anything irreversible. Say "none" only when true.

4. **Wait for CI on this commit** (`gh pr checks --watch`). Report the result for the pushed SHA (`git rev-parse HEAD`). If a check fails, read its log (`gh run view <id> --log-failed`), state the cause, fix, commit, push, and watch again. `AGENTS.md` (Verify) says when a rerun is allowed.

   Done when every required check is green for the latest pushed SHA and that SHA contains the latest `main` (`git fetch origin`, then `git merge-base --is-ancestor origin/main HEAD`). If it doesn't, merge `origin/main`, push, and watch again. Local green is not CI green.

5. Report the PR URL. Do not merge: a human reviews and merges. If `main` moves first, step 4 applies again.

6. **Once it is merged**, switch to `main`, pull, and delete the branch locally and on GitHub, as `AGENTS.md` (Workflow) describes.
