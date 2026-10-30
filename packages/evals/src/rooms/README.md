# Rooms eval

A hand-run score for how Bots behave in a Room (spec #1055, ticket #1063). It is not in CI and is
not part of the SDK a Host copies. Each run is a fresh user with a Room of three Bots (only names,
so the user's Message says who does what), one Message to it, and the real `bot` plugin on the fake
Computer. The run waits until the whole chain has ended, then scores deterministically, with no
judge, from the Messages the Bots sent (a handoff is an `@mention` of another member, found with the
SDK's own `mentionedMembers`) and the `agent` Triggers left behind. Text is normalised first (curly
quotes and dashes made plain).

## Run it

It needs a scratch Postgres with `vector`, created before the first run (the script migrates it but
does not create the database), and the API key of the Model's Provider. No E2B is used.

```sh
psql ... -c 'CREATE DATABASE "ai-chat_eval_1063"' && psql ... -d ai-chat_eval_1063 -c 'CREATE EXTENSION vector'
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_1063 \
OPENROUTER_API_KEY=... \
pnpm -F @ai-chat/evals eval:rooms
```

- `EVAL_BOT_MODEL` is the Bots' Model, a `"provider:model"` id (default
  `openrouter:anthropic/claude-sonnet-5.5`). The key variable is the Provider's.
- `EVAL_CHATGPT_USER_ID` runs a plan Model on that user's linked ChatGPT plan, as in the other sets.
- `EVAL_REPEATS` runs each case that many times (default 3). `EVAL_CONCURRENCY` runs that many
  runs at once (default 4).
- `--case=<id>` runs one case, `--limit=<n>` the first n.
- With no key set it exits 1 at once.

Give the run its own database: two evals on one database truncate each other's rows.

Every run (each member's tool calls, the observed chain and the score) is saved to
`src/rooms/results/rooms-<time>.json` (gitignored). The exit code is 0 when every gating run passed.

## The dry run, and the broken prompt

`-- --fake` (or `EVAL_FAKE=1`) runs the same wiring with the SDK's fake chat adapter, which plays
each Bot's `good` script (found by the name its Room prompt gives it): no Model or key is used, and
its pass only shows the harness and the scorers work. `-- --fake --broken` plays the `broken`
scripts, what a Bot under a deliberately broken Room prompt does (hands to the wrong member, chimes
in, replies to thanks, hands back and forth). Every case must then FAIL, and the run exits 0 only if
all of them did. The scorers' own tests (`test/rooms/score.test.ts`) do the same without a database.

## The cases

| Case           | Passes when                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| handoff-code   | A code task sent to the lead (Ledger) is handed to Forge, not Atlas, and Forge runs.                        |
| handoff-trip   | A trip task sent to the lead (Forge) is handed to Atlas, not Ledger, and Atlas runs.                        |
| answer-alone   | Forge, asked something in its own role, answers, mentions no one, and no other Bot runs.                    |
| thanks-quiet   | Two Bots are thanked: neither sends a Message or mentions anyone.                                           |
| chain-ends     | Atlas hands a sum to Ledger; at most two handoffs, no hop past the limit, the last Message mentions no one. |
| no-thanks-back | Forge hands to Ledger, who answers the user and does not thank Forge back; same bounds.                     |
