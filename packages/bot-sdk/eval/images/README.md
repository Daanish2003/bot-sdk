# Images eval

A hand-run score for a Bot's use of `generate_image` (spec #801, ticket #809). It is not in CI and is
not part of the SDK a Host copies. Each case is a fresh user and Bot with the real `bot` plugin on the
fake Computer, under a Host with one Image Model drawn by the fake image adapter. What is scored is what
the Bot asks for, not the picture. Everything is scored deterministically, with no judge, from the
Turn's tool calls (`run_tool` calls already unwrapped).

## Run it

It needs a scratch Postgres, created before the first run (the script migrates it but does not
create the database), and the API key of the Model's Provider. No E2B and no image key are used.

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_809 \
OPENROUTER_API_KEY=... \
pnpm -F @ai-chat/bot-sdk eval:images
```

- `EVAL_BOT_MODEL` is the Bots' Model, a `"provider:model"` id (default
  `openrouter:anthropic/claude-sonnet-5.5`). The key variable is the Provider's.
- `EVAL_CHATGPT_USER_ID` runs a plan Model on that user's linked plan, as in `eval/turn/README.md`.
- `EVAL_REPEATS` runs each case that many times (default 3). `EVAL_CONCURRENCY` runs that many Turns
  at once (default 4).
- `--case=<id>` runs one case, `--limit=<n>` the first n.
- With no key set it exits 1 at once. Give the run its own database: two evals on one database
  truncate each other's rows.

Every run is saved to `eval/images/results/images-<time>.json` (gitignored). The exit code is 0 when
every run passed.

## The dry run, and the broken prompt

`-- --fake` (or `EVAL_FAKE=1`) plays each case's `good` script with the SDK's fake chat adapter: no
Model or key is used, and its 5/5 only shows the harness and the scorers work. `-- --fake --broken`
plays each case's `broken` script (claims an image without making one, draws unasked, or starts over
instead of editing). Every case must then FAIL, and the run exits 0 only if all of them did. The
scorers' own tests (`test/eval/images/score.test.ts`) do the same without a database.

## The cases

| Case              | Passes when                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| generate-bicycle  | "Draw me a red bicycle": `generate_image`, then `send_to_user` with a file from `images/`.   |
| generate-logo     | The same for a bakery logo the user asks to be sent.                                         |
| no-image-formats  | "PNG or JPEG?": no `generate_image`, a Message answers.                                      |
| no-image-describe | "Describe a lighthouse": no `generate_image`, a Message answers.                             |
| edit-earlier      | "Change that image" after `images/lighthouse.png`: `editPaths` names it, then the Bot sends. |
