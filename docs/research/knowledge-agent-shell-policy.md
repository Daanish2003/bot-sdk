# The knowledge-agent template's shell policy

Research for [#201](https://github.com/Daanish2003/ai-chat/issues/201) (child of map [#197](https://github.com/Daanish2003/ai-chat/issues/197)). Researched 2026-10-12.

## Question

In vercel-labs/knowledge-agent-template (MIT), how do `shell-policy.ts` and its tests work: the allowlisted commands and flags, how arguments are parsed, re-quoted and confined to the source's directory, and the output limits? How do `kb_shell` and `kb_shell_batch` work as tools, which Vercel-specific pieces (Sandbox, Workflow, AI Gateway, the `ai` package's `tool()`) they rely on, and what does the MIT notice say that we must keep?

## Source

All paths are in [vercel-labs/knowledge-agent-template](https://github.com/vercel-labs/knowledge-agent-template) at commit **`814711f1cf5632d127606a8aaf12b4ba951f0190`** (2026-09-15), read from a shallow clone. Nothing was run or installed.

| Ref | Path                                                                                                                                                                                           | What it is                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| P   | [`packages/sdk/src/shell-policy.ts`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/packages/sdk/src/shell-policy.ts)                   | The policy: parser, allowlist, path check, re-quoting (541 lines) |
| T   | [`packages/sdk/src/shell-policy.test.ts`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/packages/sdk/src/shell-policy.test.ts)         | Its tests, `bun:test` (159 lines)                                 |
| S   | [`packages/sdk/src/tools/shell.ts`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/packages/sdk/src/tools/shell.ts)                     | Public SDK tools `bash` / `bash_batch` (call the HTTP route)      |
| R   | [`apps/app/server/api/sandbox/shell.post.ts`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/apps/app/server/api/sandbox/shell.post.ts) | HTTP route that validates, then runs in a Vercel Sandbox          |
| B   | [`apps/app/server/utils/bot/savoir.ts`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/apps/app/server/utils/bot/savoir.ts)             | In-process `bash` / `bash_batch` tools for the bots               |
| M   | [`apps/app/server/utils/sandbox/manager.ts`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/apps/app/server/utils/sandbox/manager.ts)   | Vercel Sandbox lifecycle (snapshot, reuse, 5 min timeout)         |
| L   | [`LICENSE`](https://github.com/vercel-labs/knowledge-agent-template/blob/814711f1cf5632d127606a8aaf12b4ba951f0190/LICENSE)                                                                     | MIT, "Copyright (c) 2026-present Vercel"                          |

## Answer

- **There is no `kb_shell` in the template.** The tools are named `bash` and `bash_batch` (S lines 165, 213; registered at `packages/sdk/src/index.ts:56-57` and B lines 169-170). `kb_shell`/`kb_shell_batch` are our names for them (ADR 0012).
- **The policy is one pure function**, `validateShellCommand(command, { allowedBaseDirectory, allowedCommands? })` → `{ ok: true, command }` or `{ ok: false, reason }` (P 518-541). It depends only on `node:path`, so it ports as-is to `packages/chat-sdk` with vitest in place of `bun:test`.
- **It works in three steps:** (1) a hand-written tokenizer splits the line into stages of argv and refuses every shell construct it doesn't need; (2) each stage is checked against a per-command table of allowed flags, and path operands must resolve inside the base directory; (3) the line is rebuilt with **every token single-quoted**, and callers must run that rebuilt string with `bash -c`, never the model's own input.
- **Output limits live in the callers, not the policy:** 50,000 characters each for stdout and stderr per command (R 15, 33-38; B 9, 32-37), at most 10 commands per batch (S 220; R 8), 2,000 characters per command (R 7, HTTP route only), and at most 8 stages and 64 tokens per stage (P 161-162). There is **no per-command timeout**; the only time limit is the Sandbox's 5-minute lifetime (M line 10).
- **What changes for us:** the template leans on the Vercel Sandbox (a throwaway VM) for isolation. Run as a local child process, two gaps the Sandbox hides become real: **symlinks inside a cloned repo** (the path check is purely lexical) and **the server's environment and filesystem**. See [Gaps when run locally](#gaps-when-run-locally).

## How the policy works

### 1. Parsing (`parseCommandLine`, P 233-382)

A character-by-character tokenizer, not a shell parser:

- `'…'` is taken literally; `"…"` honours only `\"`, `\\`, `\$`, `` \` `` and refuses `` ` `` and `$(` inside; a bare `\` escapes the next character.
- Spaces and tabs separate tokens. Separators `|`, `||`, `&&` and `;` split stages and are kept in order (a trailing `;` is dropped; a trailing `|`/`&&` is an error).
- **Refused outright**, each with its own reason string: newlines, `` ` `` and `$(` (command substitution), `<` and `>` (redirection), `(` `)` `{` `}` (subshells, brace groups), a single `&` (background), unbalanced quotes, a trailing backslash, empty segments, more than 8 stages, more than 64 tokens in a stage.
- It never interprets tokens, so `$HOME`, `*` or `~` stay literal text; after re-quoting, bash doesn't expand them either. A side effect: `cat docs/*.md` is passed a file literally named `docs/*.md` and fails. The prompts steer the model to `grep -rl … --include="*.md"` and `find -name` instead (T 25-28).

### 2. Per-stage validation (`validateStage`, P 434-503)

- The first token must be a key of `COMMAND_POLICIES` (and of `allowedCommands` if given); a first token containing `=` is refused as an environment assignment (`LD_PRELOAD=… grep`, T 77).
- Options are matched against the command's `options` (flags) and `valueOptions` (take a value, attached as `-n5` / `--include=*.md` or as the next token). Short clusters such as `-rlE` are checked letter by letter; a value option ends the cluster (P 411-432). `find` uses whole-word single-dash options (`singleDashWords`). `head`/`tail` also accept `-20` (`numericOption`). `--` ends options; `-` is an operand.
- **Path confinement**: every operand is `path.resolve(base, operand)`'d and must equal the base or start with `base + path.sep` (P 164-168, 495-500). `grep`/`egrep`/`fgrep` skip their first operand (the pattern) unless `-e`/`--regexp` supplied it (P 87, 490-493). `tr`, `echo`, `printf`, `basename`, `dirname` take literal operands and skip the check.
- **Values of value options are never path-checked** (e.g. `realpath --relative-to=/etc`); the allowlist only admits value options that take patterns, counts or formats, so this is safe as long as no file-reading value option is added (the tests pin `grep -f` as refused, T 106).
- **With no `allowedBaseDirectory`, no path is checked at all** (P 486; T 144-146). Every caller must pass it.

### The allowlist (P 95-157)

The file's own rule (P 89-94): no entry may be able to spawn a process or write a file, because a name-only allowlist cannot constrain what a command does with its arguments.

| Group           | Commands                                                                                  | Notably refused                               |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| File discovery  | `find`, `ls`, `tree`                                                                      | `find -exec/-delete/-fprintf/-newer`, `ls -L` |
| Content search  | `grep`, `egrep`, `fgrep`                                                                  | `grep -f` (reads patterns from a file)        |
| File reading    | `cat`, `head`, `tail`                                                                     | `tail -f`                                     |
| Text processing | `wc`, `sort`, `uniq`, `cut`, `tr`, `column`                                               | `sort -o`, `sort -T`                          |
| Utilities       | `echo`, `printf`, `basename`, `dirname`, `realpath`, `file`, `stat`, `du`, `diff`, `comm` |                                               |
| Checksums       | `md5sum`, `sha256sum`                                                                     |                                               |

Not in the table at all: `awk`, `sed`, `xargs`, `tee`, `less`, interpreters, network tools (T 43-58). `ALLOWED_BASH_COMMANDS` exports the names (P 159). Some allowed flags follow symlinks: `find -follow`, `grep -R`, `file -L`, `stat -L`, `du -L`.

### 3. Re-quoting (`quoteToken`, P 505-508, 536-540)

Each token becomes `'…'` with embedded `'` written as `'\''`; stages are joined with their original separators. Example (T 110-116): `grep -rlE "term1|term2" docs/ | head -5` → `'grep' '-rlE' 'term1|term2' 'docs/' | 'head' '-5'`. Re-validating the output gives the same output (idempotent, T 129-134). The only shell syntax left in the string is the separators the policy accepted.

### The tests (T)

18 cases in two `describe`s (16 for `validateShellCommand`, 2 for the path helpers): accepted documented patterns; refused commands (`curl`, `awk 'BEGIN{system(…)}'`, `xargs`, `sed -i`, `python -c`); refused writes (`tee`, `sort -o`, `find -delete`, `find -fprintf`, `>`/`>>`); refused substitution, background, subshell, newline and env assignment; paths outside the base in every spelling (absolute, quoted, `../`, `./../`, `/base/../..`, mixed operands); grep pattern vs `-e`; malformed quoting; disallowed flags; exact re-quoted output, metacharacters inside arguments (`'a; id'`), embedded quotes, idempotence; narrowed `allowedCommands`; no base directory → no path checks; and two cases for `isPathWithinDirectory` / `pathMatchesGlob`. All asserts use the base `/vercel/sandbox`, so on Windows they rely on `path` being POSIX; a port that runs tests on Windows should use `node:path/posix` or a temp directory.

## How the tools work

Two copies of the same pair exist:

- **SDK tools** (S): `tool()` from the `ai` package, zod `inputSchema` (`{ command: string }` and `{ commands: string[] }` with `.min(1).max(10)`), `inputExamples`, and an **async-generator `execute`** that yields `{ status: 'loading' }` then `{ status: 'done', success, durationMs, stdout, stderr, exitCode, commands: [...] }` (batch: `results` plus `commands`). They validate locally, return a failure result (exit code 1, reason as stderr) instead of throwing, then POST to `/api/sandbox/shell` through `SavoirClient.bash` / `bashBatch` (`packages/sdk/src/client.ts:136-147`). A batch is validated whole first: one bad command fails the batch and none runs.
- **HTTP route** (R): zod body (`command` xor `commands`, each 1-2,000 chars, ≤10), re-validates every command (400 on failure), gets or reuses a sandbox session, then runs each **sequentially** as `sandbox.runCommand({ cmd: 'bash', args: ['-c', sanitized], cwd: '/vercel/sandbox' })`, truncating stdout and stderr to 50,000 chars with a `... (truncated, N total chars)` marker.
- **Bot tools** (B): the same pair in-process, calling the Sandbox directly; a refused command throws (403) rather than returning a result.

The agent loop is `ToolLoopAgent` with `stopWhen: stepCountIs(maxSteps)`, default 15 and capped at 30 by a router model (`packages/agent/src/agents/base.ts:22,60`; `packages/agent/src/router/schema.ts:11,29`). The prompts push `bash_batch` over `bash` ("search and read in one call", `packages/agent/src/prompts/chat.ts:59-86`).

## Vercel-specific pieces and their replacements

| Template piece                                                                                                                                 | Where                                                      | Our replacement (map #197, ADRs 0011, 0012)                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool()` from `ai` (^6.0.78), async-generator `execute`, `inputExamples`                                                                       | S, B                                                       | `toolDefinition({ name, description, inputSchema }).server(async (input, context) => …)` from `@tanstack/ai` 0.66.0, built per Run, as in `packages/chat-sdk/core/server/chat/web-search-tool.ts`. One return value instead of yielded progress; progress goes through the parts builder and `onChange`, as `web_search` does. |
| `@vercel/sandbox` (^1.4.1): `Sandbox.create({ source: { type: 'snapshot' }, runtime: 'node24', timeout: 5 min })`, session reuse, `runCommand` | M, R, B                                                    | A local child process: `spawn('bash', ['-c', sanitized], { cwd: sourceDir, env: minimal, signal })` in the cached commit's folder (ADR 0012).                                                                                                                                                                                  |
| Snapshot of one docs repo (all sources in one sandbox), `.git` stripped with `rm -rf` (`apps/app/server/utils/sandbox/git.ts:122`)             | M, `apps/app/server/utils/sandbox/snapshot-sync.ts`        | One folder per Synced source per commit, shallow-cloned on a miss; `allowedBaseDirectory` is that folder.                                                                                                                                                                                                                      |
| Vercel Workflow (`workflow` 4.2.0-beta.72, `'use workflow'`, `FatalError`) for sync and snapshot jobs                                          | `apps/app/server/workflows/sync-docs/`, `create-snapshot/` | `packages/durable-runner` (ADR 0011). Not used by the shell tools themselves.                                                                                                                                                                                                                                                  |
| AI Gateway (`providerOptions.gateway` with model fallbacks, user, tags)                                                                        | `packages/agent/src/router/schema.ts:45-59`                | Our Provider adapters. Not used by the shell tools themselves.                                                                                                                                                                                                                                                                 |
| `ToolLoopAgent` + `stepCountIs`                                                                                                                | `packages/agent/src/agents/*.ts`                           | Our Run loop's own limits; a per-reply call budget inside the tool, like `maxSearchesPerReply`.                                                                                                                                                                                                                                |

`shell-policy.ts` itself uses none of these; it is the only file worth copying. The tools and route are short and better rewritten against our own seams.

## Gaps when run locally

These don't bite inside a throwaway Vercel Sandbox VM; they do on our server.

1. **Symlinks escape the path check.** `isPathWithinDirectory` is lexical (`path.resolve`, P 164-168), and nothing in the template looks at symlinks (no `lstat`/`realpath` anywhere in `apps/` or `packages/`). A repository can commit `notes -> /proc/self/environ` or `-> /etc/passwd`; `cat notes` passes the policy and `cat` follows the link. Options: check out with `git -c core.symlinks=false` (links become plain text files holding the target), delete symlinks after clone, or resolve each operand with `fs.realpath` before the check. The first is simplest; a test with a planted symlink should prove it.
2. **The child inherits `process.env`** (database URL, provider keys, auth secret) unless `env` is set. Pass a minimal env (`PATH`, `LANG`) so nothing leaks even through a missed path.
3. **No timeout or output cap at the process level.** The template truncates after reading the full output. Locally, set a per-command timeout and kill on the Run's `abortSignal`, and stop reading stdout past the cap (`spawn` with a byte counter, or `execFile`'s `maxBuffer`), so `grep -r` over a large repo can't tie up the server.
4. **Always pass `allowedBaseDirectory`** and set `cwd` to the same folder: with no base directory nothing is checked, and an operand-less `grep -r x` or `find` searches `cwd`.
5. **Windows dev machines:** `bash -c` and GNU `find`/`grep` exist only through Git Bash or WSL. Running each stage as its own `spawn` with piped stdio would avoid bash, but then `&&`, `||` and `;` need re-implementing; `bash -c` on the re-quoted string is the template's tested path.

## The MIT notice

The `LICENSE` at the repo root (L) is the standard MIT text with **"Copyright (c) 2026-present Vercel"**; `packages/sdk/package.json` also declares `"license": "MIT"` (author Hugo Richard), and no source file carries its own header. The one condition: _"The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."_ So a port of `shell-policy.ts` (and its tests, if adapted) must carry that copyright line and the full permission notice, for example as a header comment in the ported file naming the source repo and commit, or in a `NOTICE`/third-party file that ships with the package, alongside the Sim Studio Apache-2.0 notice the map already calls for.
