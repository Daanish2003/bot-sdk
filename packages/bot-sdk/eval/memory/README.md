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

### On a ChatGPT plan

With `EVAL_CHATGPT_USER_ID` and the web app's settings set (see "On a ChatGPT plan" in
`eval/turn/README.md`), the plan's Models (`openai:gpt-6.1-sol`, `openai:gpt-6-luna`) run on the
linked plan, and the judge defaults to `openai:gpt-6-luna`. No OpenAI key is saved, because a saved key
would come before the plan. So every `openai:` Model has to be a plan Model, and embeddings use
Gemini: set `GEMINI_API_KEY` (the free tier is enough). The judge runs without temperature 0, so its
verdicts can vary between runs.

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval \
EVAL_BACKGROUND_MODEL=openai:gpt-6-luna EVAL_ANSWER_MODEL=openai:gpt-6.1-sol \
EVAL_CHATGPT_USER_ID=<your user id> DATABASE_URL=... BETTER_AUTH_URL=... BETTER_AUTH_SECRET=... \
CHATGPT_CLIENT_ID=... CHATGPT_HOST_ID=... GEMINI_API_KEY=... \
pnpm -F @ai-chat/bot-sdk eval:memory
```

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
