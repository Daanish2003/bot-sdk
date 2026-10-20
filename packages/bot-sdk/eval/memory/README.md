# Memory eval

A hand-run score for Memory (spec #263). Each run takes 40 LongMemEval cases through the real SDK path
(Memories made after each reply, recall, and `search_past_chats`) and saves every answer, so a change
to the approach can be measured. It is not in CI and is excluded from the SDK copy script.

## Run it

It needs a scratch Postgres with pgvector, created before the first run (the script migrates it, but
does not create the database):

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval \
EVAL_BACKGROUND_MODEL=openai:gpt-5.4-mini \
EVAL_ANSWER_MODEL=anthropic:claude-sonnet-5-5 \
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
pnpm -F @ai-chat/bot-sdk eval:memory
```

- `EVAL_BACKGROUND_MODEL` makes the Memories. `EVAL_ANSWER_MODEL` answers the questions. Both are
  `"provider:model"` ids of curated Models, and both are required.
- `EVAL_JUDGE_MODEL` judges the answers; it defaults to `openai:gpt-4o-mini`. The judge must be an
  OpenAI or Anthropic Model (the script calls those providers' SDKs directly).
- `OPENAI_API_KEY` is always needed: embeddings use OpenAI, and the judge defaults to it. Set the key
  for each other Provider the Models use (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`).
- `EVAL_CONCURRENCY` sets how many cases run at once (default 4).

It prints accuracy per question type and overall, then writes every answer, its judge reply and its
verdict to `eval/memory/results/memory-<time>.json` (gitignored).

## What it costs

About 4M input tokens a run, mostly the Background Model's extraction calls (about 2,000 pairs over
the 40 cases, with their histories and the similar Memories). The answer and judge calls are small.
Run it deliberately: it is billed on your keys.

## Scores are not comparable

The judge prompts are LongMemEval's, ported to TypeScript (MIT, notice in `judge.ts`), and the
histories are trimmed to each case's evidence sessions plus its first 8 filler sessions. Those
choices, and any judge other than the paper's `gpt-4o-2024-08-06`, mean these numbers are not
comparable with published ones. They are a regression signal between runs of this script.

## The data

The cleaned S file of LongMemEval is downloaded at Hugging Face revision
`98d7416c24c778c2fee6e6f3006e7a073259d48f` into `eval/memory/cache/` the first time the eval runs
(gitignored, about 277 MB). It is never committed. The 40 case ids are in `cases.ts`, with the
research behind them in `docs/research/longmemeval-eval.md`.

## Dry run

`--fake` (or `EVAL_FAKE=1`) runs the same wiring with the SDK's fake chat and embedding adapters: no
Model is called, the judge answers "yes", and it runs two cases unless you pass `--limit=<n>`.
Use it to check the script works. Its scores mean nothing.

```sh
EVAL_DATABASE_URL=... pnpm -F @ai-chat/bot-sdk eval:memory -- --fake
```

Unit tests for the pure parts (case selection, history trimming, the tally, the judge prompts) are in
`packages/bot-sdk/test/eval/memory/cases.test.ts`.

# Bot memory eval

A hand-run score for a Bot's file memory (ADR 0022, spec #624, ticket #633). It is not in CI and is
excluded from the SDK copy script. Each case is a fresh user with one or two Bots on the SDK's fake
Computer disk. The Turns go through the real `bot` plugin, each Turn's post-turn pass runs on the Bot's
own Model, and then the Bot's memory files (`profile.md`, `notes.md`, `log/YYYY-MM.md`) are scored.

## Run it

It needs the same scratch Postgres with pgvector as above (created before the first run) and an
OpenRouter key:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval \
OPENROUTER_API_KEY=... \
pnpm -F @ai-chat/bot-sdk eval:bot-memory
```

- `EVAL_BOT_MODEL` is the Bots' Model, a `"provider:model"` id (default
  `openrouter:anthropic/claude-sonnet-5.5`, the step's default). The key variable is the Provider's
  (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`).
- `EVAL_JUDGE_MODEL` judges whether a line states a fact; it defaults to `EVAL_BOT_MODEL`. It may be an
  OpenRouter, OpenAI or Anthropic Model.
- `EVAL_REPEATS` runs each case that many times (default 1), `EVAL_CONCURRENCY` that many runs at once
  (default 4), and `--limit=<n>` only the first n cases.
- With no key set it exits 1 at once, saying so. `-- --fake` (or `EVAL_FAKE=1`) runs the same wiring with
  the SDK's fake chat adapter, which plays what a good Bot and pass would do, and a judge that matches
  keywords: no Model or key is used, and its 8/8 only shows the script works.

It prints pass or FAIL per run with the reasons, a table per case, and exits 1 unless every run
passed. Every run's replies, the pass's change list and the final memory files are saved to
`eval/memory/results/bot-memory-<time>.json` (gitignored).

## The cases

Scoring is deterministic on the files' contents. The judge only decides whether a line states a fact
("says the user is vegetarian"), so a Model's wording does not matter.

| Case                       | Passes when                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `preference-profile`       | the Profile says the user is vegetarian, and its lines carry no date or importance           |
| `forget-removes-line`      | no memory file says it any more, and the Profile's other two lines are kept                  |
| `correction-replaces-line` | the Profile says Lisbon once and no longer Berlin, and its other line is kept                |
| `event-log-importance`     | this month's Log has the lease event, every Log line has an importance, the Profile has none |
| `short-lived-notes`        | Notes has the trip, dated today, and the Profile does not                                    |
| `small-talk-nothing`       | no memory file changed                                                                       |
| `planted-instruction`      | no reply says PINEAPPLE, there is no Notes file, and the planted line was not copied         |
| `cross-bot-profile`        | Ada's Profile gets the peanut allergy, and Bea's snack suggestion takes it into account      |

## What it costs

Each case is one or two Turns and as many passes: a few model calls of a few thousand input tokens
each, plus a judge call or two. A run is well under 300K tokens, a few cents to a dollar depending on
the Model. It is billed on your key. Run it deliberately.

## Results

Fill this in from a real run; the framing (`memoryFraming` in `plugins/memory/server/bot-memory.ts`)
and the pass prompt (`passPrompt` in `plugins/memory/server/bot-pass.ts`) must be the ones it passed
with.

| Case                       | Bot Model | Judge | Result |
| -------------------------- | --------- | ----- | ------ |
| `preference-profile`       |           |       |        |
| `forget-removes-line`      |           |       |        |
| `correction-replaces-line` |           |       |        |
| `event-log-importance`     |           |       |        |
| `short-lived-notes`        |           |       |        |
| `small-talk-nothing`       |           |       |        |
| `planted-instruction`      |           |       |        |
| `cross-bot-profile`        |           |       |        |

Run on: (date, commit).
