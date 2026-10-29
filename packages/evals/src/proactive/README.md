# Proactive eval

A hand-run score for the Morning brief and the Watch (spec #1024, ticket #1032). It is not in CI and
is not part of the SDK a Host copies. Each case is a fresh user and Bot with the real `bot`, `mcp`
and `memory` plugins on the fake Computer, the user holding one Connection, "Mail", over the SDK's
fake MCP server (`fake-mcp-server.ts` in `@ai-chat/test-support`) with scripted inbox items. Its
`list_inbox` tool is marked `readOnlyHint`; `send_email` has no hint, so a Watch run refuses it.
Everything is scored deterministically, with no judge, from the Turn's tool calls (a `run_tool` call
counts as the tool it names). Text is normalised first (curly quotes and dashes made plain).

The Watch and the Morning brief are saved as active Routines with the SDK's own default prompts
(`proactiveRoutinesPrompt`) and fired through the Router like a real fire, so the eval judges what a
Host gets.

## Run it

It needs a scratch Postgres, created before the first run (the script migrates it but does not
create the database), and a Model: a key for the Model's Provider, or the owner's ChatGPT plan. No
E2B and no real MCP server are used.

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_1032 \
EVAL_BOT_MODEL=openai:gpt-6.1-sol EVAL_CHATGPT_USER_ID=<user id of the chatgpt account row> \
pnpm -F @ai-chat/evals eval:proactive
```

- `EVAL_BOT_MODEL` is the Bots' Model, a `"provider:model"` id (default
  `openrouter:anthropic/claude-sonnet-5.5`). The key variable is the Provider's.
- `EVAL_REPEATS` runs each case that many times (default 3). `EVAL_CONCURRENCY` runs that many Turns
  at once (default 4).
- `--case=<id>` runs one case, `--limit=<n>` the first n.
- `EVAL_PRICE_INPUT`, `EVAL_PRICE_OUTPUT`, `EVAL_PRICE_CACHE_READ` and `EVAL_PRICE_CACHE_WRITE` are
  dollars per million tokens for the list-price cost (default Sonnet's 3, 15, 0.3 and 3.75).

Give the run its own database: two evals on one database truncate each other's rows.

Every run (tool calls, scores, cost) is saved to `src/proactive/results/proactive-<time>.json`
(gitignored). The exit code is 0 when every gating run passed.

## The cost of a Watch run

Each Watch run is priced from the `usage` rows its Turn wrote (`source_id` is the Turn): the tokens
(input, cached, written to the cache, output) and the cost the rows record. A user's own key or
linked plan records 0, so the report also prices the same tokens at list prices. The run prints the
mean and the maximum, to replace the spec's $0.13-0.19 estimate. A Watch run with no usage rows
fails. Only rows sourced from the Turn count (its Model calls and Auto-reviews); the Memory pass after it books its own rows, which are not in the figure.

## The dry run, and the broken prompt

`-- --fake` (or `EVAL_FAKE=1`) runs the same wiring with the SDK's fake chat adapter, which plays
each Turn's `good` script with fake usage: no Model or key is used, and its pass only shows the
harness and the scorers work. `-- --fake --broken` plays each Turn's `broken` script, which is what a
Bot under a deliberately broken prompt does (reports "nothing new", repeats a Noted item, sends an
urgent item unmarked, messages instead of noting, retries a refused write, offers nothing). Every
case must then FAIL, and the run exits 0 only if all of them did. The scorers' own tests
(`test/proactive/score.test.ts`) do the same without a database.

## The cases

| Case              | Passes when                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| watch-quiet       | The inbox holds nothing new: the Watch sends no Message and tries nothing it can't do.                                                              |
| watch-no-repeat   | The one item is already in `notes.md`: the Watch sends no Message.                                                                                  |
| watch-urgent      | A payments outage: the Watch sends a Message about it with `urgent: true`.                                                                          |
| watch-note-brief  | A non-urgent item: the Watch sends nothing and writes a Note; the next brief Turn (empty inbox) tells the user of it.                               |
| watch-write-draft | An email wants a yes or no: the Watch sends a draft with a choice, and tries the refused send at most once.                                         |
| first-offers      | After its first Connection, the first Bot saves the Morning brief and the Watch (weekdays 08:00; weekdays 11, 14, 17, 20, read-only), both pending. |
