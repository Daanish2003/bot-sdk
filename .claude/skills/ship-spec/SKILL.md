---
name: ship-spec
description: "Implement every ticket of one spec issue with parallel subagents in worktrees, merged into one feature branch."
argument-hint: "<spec issue number>"
disable-model-invocation: true
---

You are the **orchestrator** for one spec issue (the argument). Its sub-issues are the tickets. The goal is every ticket implemented on one **integration branch** `feature/<spec-slug>`, with every ticket closed and the branch PR'd to main.

You write no feature code. You plan, brief, merge, verify and clean up. **Implementers** are subagents, at most **4** running at once, each in its own worktree, each on the model you pick for its ticket (see [Choosing the model](#choosing-the-model)). Communicate through **context pointers** (issue URLs, commit SHAs, file paths), never by pasting what a pointer already holds.

Read [environment.md](environment.md) before step 2. It holds this machine's gotchas (ports, databases, CRLF, migrations), and every step below assumes them.

## 1. Dependency map

1. Fetch the spec and its sub-issues: body, state, labels, and native `blocked_by` for each (see `docs/agents/issue-tracker.md`).
2. Build the **task graph**:
   - every open ticket and its blockers, including blockers **outside** the spec, which are flagged as external;
   - topological layers, where layer 0 is the **frontier** (open, unblocked, unassigned);
   - the **critical path** (the longest chain), which gets slot priority;
   - **slots**: tickets that add a migration or run e2e, which are serialised (see environment.md);
   - owner decisions already visible (AGENTS.md §6 items a ticket needs and its spec doesn't settle);
   - each ticket's **model**, with a few words of reason.
3. Post the map as one comment on the spec. It is the run's recovery point. Show it to the user and **continue without waiting**, unless an external blocker is open or an owner decision gates layer 0. Then ask, with AskUserQuestion, before starting.

Done when: the comment is posted and every open ticket appears in exactly one layer.

## Choosing the model

Pick the cheapest model that will get the ticket **right the first time**. A failed attempt costs more than the price gap between models.

- **`haiku`**: the work is mechanical and fully specified, touches few files, and lands on a seam no other running ticket touches. Examples: a rename, a copy rule, a test-first bug fix with a clear repro, a docs or lesson ticket that follows an existing format.
- **`sonnet`**: the default for feature slices that cross layers or several modules, and for tickets whose acceptance criteria need judgement.
- **`opus`**: a ticket that changes a shared interface many modules depend on (a wide refactor, the contract step of expand–contract), touches concurrency, transactions or migrations, or is likely to collide with another running ticket on substance.

**Escalate on evidence.** When an implementer reports `blocked` from confusion rather than a denial, fails the same check twice, or hands back work that misses its acceptance criteria, relaunch the ticket one tier up in the same worktree. Point the new agent at the old one's handoff. Record the change and the reason on the map comment.

## 2. Set up

1. **Check the services.** Postgres must answer on `127.0.0.1:5435` with the `vector` extension available, and Redis on `127.0.0.1:6380`. If either is down, start it as environment.md says, then check again. If Docker itself isn't running, ask the user to start Docker Desktop.
2. Create `feature/<spec-slug>` from `origin/main` (or from the base the spec names) and push it.
3. Create the integration worktree as environment.md says.
4. Write the **run brief** to `%TEMP%/ai-chat-ship-<spec>.md` from [brief.md](brief.md). Fill in its blanks (spec, integration branch, slot holders) and add nothing that a pointer already holds.
5. Write a memory file `ship-spec-<spec>.md` with the branch, worktree paths and brief path, and add its line to MEMORY.md. Update it at each merge; after a compaction, it plus `git worktree list` and the open sub-issues tell you where the run is.

## 3. Run the frontier

Repeat until no ticket is open:

1. **Fill free slots** (≤4) from the frontier, critical path first. For each ticket:
   - assign it to `@me`;
   - create its worktree (`../ai-chat-wt/<N>`, branch `<type>/<N>-<slug>` from the integration tip). Create worktrees one at a time; they race on `.git/config`;
   - launch an implementer: Agent tool with the ticket's `model`, `run_in_background: true`, and **no** `isolation` (the worktree is pre-made). The prompt is three pointers: the ticket URL, the worktree path, and the run brief path.
2. **When an implementer reports**, check its report against the brief's report shape:
   - **Done:** the base is the current integration tip or an ancestor of it, the commit SHAs are listed, the affected tests are green, and `checks` lists the `code-review` run. If the review is missing, resume the agent with SendMessage to run it before you merge. Go to step 4.
   - **Owner decision:** post the question on the ticket, ask the user (batch any open questions into one AskUserQuestion), and keep the other slots busy. Resume the same agent with SendMessage once answered.
   - **Blocked or denied** (a permission denial, a broken base): do the step yourself if it is yours, or ask the user. Never retry a denied command verbatim.
3. Keep going between tickets. Report to the user only at the end or when blocked.

## 4. Merge, verify, close

For each finished ticket, in the integration worktree:

1. Merge the ticket branch (`--no-ff`, unless it fast-forwards onto the exact commit its agent tested). Resolve conflicts on **substance**: when two tickets changed the same seam, keep both behaviours and read both tickets' acceptance criteria; never pick a side blindly. Call the Skill tool with `codebase-design` when a conflict is about where a seam goes.
2. **Verify** with [verify.sh](verify.sh) on the integration worktree. It must end with `VERIFY OK`. You may batch 3–4 merges into one verify, and bisect only on failure. A fast-forward onto the commit the agent tested skips the verify.
3. When it's red: send the failure back to the agent that wrote the ticket (SendMessage, same worktree), or fix it in a fresh implementer if that agent is gone. Never push red.
4. Push the integration branch. Close the ticket with a comment giving the merge SHA. Remove its worktree and delete its branch with `git branch -d`; if `-d` refuses, add the branch to the user's cleanup list.
5. Update the memory file, then recompute the frontier and go back to step 3.

Done when: the ticket is closed, its merge is on `origin/feature/<spec-slug>`, and its worktree is gone.

## 5. Finish

1. Call the Skill tool with `code-review` on `feature/<spec-slug>` against main. Fix every confirmed finding in one implementer, then merge and verify as in step 4.
2. Run the full e2e suite once on the integration tip (environment.md), plus any acceptance criterion that needs a real PR or CI run.
3. Open the PR `feature/<spec-slug>` → main, written with the `/pr` skill's template (read `.claude/skills/pr/SKILL.md`), with `Closes #<spec>`. Wait for CI on that SHA. Ask the user to merge: auto mode blocks merging an unreviewed PR.
4. After the merge, clean up as AGENTS.md §7 says: integration worktree, feature branch (local and origin), `git fetch --prune`. Close the spec if it's still open. Give the user the `git branch -D` commands for anything `-d` refused, as single-line `!` commands.
5. **Improve this skill.** Append each new gotcha the run hit (a trap that cost a retry, a denial, a flaky check) to environment.md, one bullet each, in the section it belongs to. Delete any bullet the run proved wrong. Then tell the user, in your final report, which changes you made to this skill, and what you'd change in it that needs their say.

Done when: the PR is merged, every worktree and branch from the run is removed or on the user's list, and environment.md carries the run's lessons.
