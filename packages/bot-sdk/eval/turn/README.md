# Turn eval

A hand-run score for the week-one Bot Turn (spec #463, "Evals for the week-one Turn"). It checks that a
real Model, under the fixed Bot system prompt, sends a Message through SendToUser when it should, stays
quiet when it should, and sets `endTurn` on its last Message. It is not in CI and is excluded from the
SDK copy script.

## Run it

It needs a scratch Postgres with pgvector, created before the first run (the script migrates it, but
does not create the database), and the API key of the Model's Provider:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval \
EVAL_BOT_MODEL=anthropic:claude-haiku-4-5 \
ANTHROPIC_API_KEY=... \
pnpm -F @ai-chat/bot-sdk eval:turn
```

- `EVAL_BOT_MODEL` is the Bot's Model, a curated `"provider:model"` id. It is required.
- The key variable is `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `OPENROUTER_API_KEY`,
  for the Model's Provider.
- `EVAL_REPEATS` runs each case that many times (default 3), since a Model's answer varies.
- `EVAL_CONCURRENCY` sets how many runs go at once (default 4).
- `--limit=<n>` runs only the first n cases.

Each run gets a fresh user and Bot through the real `bot` plugin: the case's history is written as
earlier Turns, then the new user Message is sent with `sendToBot`. There is no threshold: read the
rates and compare them between Models and between prompt changes.

## How it scores

The score is deterministic; there is no judge. About 20 clear-cut cases, 10 where the Bot should reply
(two ask for several Messages) and 10 where it should stay quiet ("👍", "ok", "brb", "nvm, figured it
out" after a Bot answer). Borderline messages like "thanks!" are left out on purpose.

- A **reply** case passes with at least one Message, `endTurn: true` on the last SendToUser call, and
  no model call after it. A multi-message case also needs at least two Messages, with `endTurn` only on
  the last.
- A **quiet** case passes with no Message and a `complete` Turn.
- The run prints the pass rate for the reply group, the quiet group, and the endTurn group (the runs
  that sent something and got `endTurn` right), and the reason for each failure. Every run, with the
  text it sent, is saved to `eval/turn/results/turn-<time>.json` (gitignored).

## What it costs

Every run is one Turn: a short history and one to three model calls. At 20 cases and 3 repeats that is
60 Turns, about 100 model calls of a few hundred input tokens each, so well under 100K tokens in total,
a few cents on a small Model. It is billed on your key. Run it deliberately.

## Which Model

A small, fast Model of each Provider is enough to compare, and the cheapest way to see the difference
between Providers. Suggested defaults:

| Provider   | Suggested `EVAL_BOT_MODEL`     |
| ---------- | ------------------------------ |
| Anthropic  | `anthropic:claude-haiku-4-5`   |
| OpenAI     | `openai:gpt-5.4-mini`          |
| Gemini     | `gemini:gemini-3.5-flash-lite` |
| OpenRouter | `openrouter:<a curated Model>` |

The id must be one of the SDK's curated Models; the run fails at the first Turn when it is not.

## Dry run

`--fake` (or `EVAL_FAKE=1`) runs the same wiring with the SDK's fake chat adapter, which plays what each
case expects: no Model is called and no key is needed. Use it to check the script works. Its scores
mean nothing.

```sh
EVAL_DATABASE_URL=... pnpm -F @ai-chat/bot-sdk eval:turn -- --fake
```

## Queue evals (batching and interrupting)

The same run also plays two cases of the Router and queue (spec #510) with the real `bot` plugin and
client ids, `EVAL_REPEATS` times each. Each has a structural check and an LLM-judge check:

- **batching:** "Plan a dinner." / "For 4 people." / "Vegetarian." sent 200 ms apart. Structural:
  exactly one Turn took all three Triggers and completed. Judge: the reply covers all three.
- **interrupting:** "Book the meeting for Wednesday", then, once the Turn's job is running, "Actually,
  make it Thursday". Structural: the first Turn ended `stopped`, a second Turn took the correction and
  completed. Judge: the reply says Thursday, not Wednesday.

The structural check reads Turns and Triggers, never the Model's text. The judge answers `Verdict:` and
`Reason:`, both printed per run and saved in the results file. `EVAL_JUDGE_MODEL` (an `openai:`,
`anthropic:` or `openrouter:` Model) sets the judge; it defaults to `EVAL_BOT_MODEL`, so that must be one of those
Providers unless you set it. `--limit` limits only the week-one cases.
