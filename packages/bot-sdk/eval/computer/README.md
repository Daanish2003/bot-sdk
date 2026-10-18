# Computer evals

Two hand-run evals for the Bot's Computer (spec #519, "Evals"). Neither is in CI, and both are excluded
from the SDK copy script (it skips every `eval/` folder).

- **Tool use** (`eval:computer`, needs a real Model): does the Bot use `shell` and the file tools when
  a task needs them, and leave the Computer alone in plain chat?
- **Lifecycle** (`eval:computer:lifecycle`, no Model): does the real `computer` plugin, on the E2B
  adapter, sleep, wake and rebuild a Computer with its files intact?

Both run against the local E2B Embed (see the SDK README, "Local E2B Embed") with the Computer template
built, and a scratch Postgres with pgvector, created before the first run (the scripts migrate it, but
do not create the database).

## Environment

```sh
# the three E2B values, from the Embed's `ready` container (SDK README)
export E2B_API_KEY=... E2B_API_URL=http://localhost:3000 E2B_SANDBOX_URL=http://localhost:3002
export EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval
```

- `EVAL_TEMPLATE` is the template Computers are built from (default `ai-chat-computer-v2`).
- The local Embed fits one sandbox at a time, and a sandbox that will not start fails with `Failed to
place sandbox` (`mmap memfd: cannot allocate memory` in the orchestrator log) when WSL's page cache
  has filled the memory. Free it before each run (SDK README, "The template").

## Tool use

```sh
EVAL_BOT_MODEL=anthropic:claude-haiku-4-5 ANTHROPIC_API_KEY=... \
pnpm -F @ai-chat/bot-sdk eval:computer
```

- `EVAL_BOT_MODEL` is the Bot's Model, a curated `"provider:model"` id (required). The key variable is
  the Provider's: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `OPENROUTER_API_KEY`.
- `EVAL_REPEATS` runs each case that many times (default 3). `--limit=<n>` runs the first n cases.
- `--fake` (or `EVAL_FAKE=1`) plays each case's scripted tool calls instead of a Model, so no key is
  needed. The Computer and the files are still real; the scores only show the script works.

Each run is a fresh user, Bot and Computer, driven by `sendToBot` through the real `bot` plugin. The
runs go one at a time, and each run's sandbox is killed when it ends.

Eight clear-cut cases, scored deterministically with no judge:

- **use** (the Bot should touch the Computer): `compute-product` (the reply gives the exact product of
  two numbers), `save-note` (a named file holds the three items), `read-earlier-file` (the reply gives
  a code from a file an earlier Turn saved) and `edit-file` (one line changed, the others kept).
- **none** (plain chat, so a Computer tool call fails the run): a greeting, a capital, a poem, a
  one-sentence explanation.

The output is the pass rate per case and for the `use` and `none` groups over the repeats. There is no
threshold: compare the rates between Models and between prompt changes. Every run (tools called, the
Messages sent, the reasons for a failure) is saved to `eval/computer/results/computer-<time>.json`
(gitignored).

A run costs one Turn of two to four model calls, so the default 8 cases x 3 repeats is about 24 Turns,
a few cents on a small Model. It is billed on your key.

## Lifecycle

```sh
pnpm -F @ai-chat/bot-sdk eval:computer:lifecycle
```

It needs a second template, built from the same Dockerfile under another name, so the last step can
change the template name (`EVAL_REBUILD_TEMPLATE`, default `ai-chat-computer-v2-eval`):

```sh
pnpm dlx @e2b/cli@2.22.0 template create ai-chat-computer-v2-eval -p plugins/computer/template -d Dockerfile
```

It drives one user's Computer through the real plugin, and prints pass or fail for each check:

1. Writes a file and starts a process.
2. Ages `last_active_at` and runs the queued sleep check, then asserts the Computer is `asleep`, the
   sandbox is kept and the archive is stored.
3. Runs an operation, then asserts the file and the process survived the pause, in the same sandbox.
4. Changes the template name (a second plugin instance on the other template), then asserts the next
   operation rebuilt the Computer from the new template, restored the file, and reports the rebuild.

It ends with the timings of the provider's `create`, `pause` and `resume` calls, and exits non-zero
when a check fails. On a first run it reported, on this machine: create about 400 ms, pause about
100 to 140 ms, resume about 130 ms, a rebuild about 600 ms.

Step 4 kills the paused sandbox first: with one sandbox at a time, creating the rebuilt one while the old
one is paused fails to place it. The rebuild is the same, since a changed template never resumes the old
sandbox, and the kill the plugin ends a rebuild with is then a no-op. The process does not survive a
rebuild, only the files do, so step 4 does not check it.
