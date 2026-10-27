# Turn eval

A hand-run score for the week-one Bot Turn (spec #463, "Evals for the week-one Turn"). It checks that a
real Model, under the fixed Bot system prompt, sends a Message through SendToUser when it should, stays
quiet when it should, and sets `endTurn` on its last Message. It is not in CI and is not part of the SDK a Host copies.

## Run it

It needs a scratch Postgres, created before the first run (the script migrates it, but
does not create the database), and the API key of the Model's Provider:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval \
EVAL_BOT_MODEL=anthropic:claude-haiku-4-5 \
ANTHROPIC_API_KEY=... \
pnpm -F @ai-chat/evals eval:turn
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
- A **quiet** case passes with no Message and a `complete` Turn. Quiet means a reply with no text: a
  Step that ends in plain text gets one more Step after a note that the text was not delivered
  (#531), so plain text the Model meant only for itself can still turn into a sent Message and fail.
- The run prints the pass rate for the reply group, the quiet group, and the endTurn group (the runs
  that sent something and got `endTurn` right), and the reason for each failure. Every run, with the
  text it sent, is saved to `src/turn/results/turn-<time>.json` (gitignored).

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

## On a ChatGPT plan

With no API key, the runs can use a ChatGPT plan linked on the web app's Keys page (#637). Set
`EVAL_CHATGPT_USER_ID` to the id of the user who linked it, plus the web app's own `DATABASE_URL`,
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `CHATGPT_CLIENT_ID` and `CHATGPT_HOST_ID` (from
`apps/web/.env`). Then the plan's Models, `openai:gpt-6.1-sol` and `openai:gpt-6-luna`, run on the
plan with no `OPENAI_API_KEY`, the same way they do in the web app. That covers the Bot and the judge.
This works for `eval:turn` and `eval:ladder`.

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval \
EVAL_BOT_MODEL=openai:gpt-6-luna EVAL_JUDGE_MODEL=openai:gpt-6.1-sol \
EVAL_CHATGPT_USER_ID=<your user id> DATABASE_URL=... BETTER_AUTH_URL=... BETTER_AUTH_SECRET=... \
CHATGPT_CLIENT_ID=... CHATGPT_HOST_ID=... \
pnpm -F @ai-chat/evals eval:turn
```

- The token is read from the link on each call through Better Auth, which refreshes it and saves the
  new tokens, so the web app's link keeps working.
- The plan refuses `temperature`, so its judge runs at the Model's default. Its verdicts can vary
  between runs and aren't comparable with runs judged at temperature 0.
- The plan has a usage limit, so a 429 fails the run that hit it. Lower `EVAL_CONCURRENCY` or
  `EVAL_REPEATS` if that happens.

## Dry run

`--fake` (or `EVAL_FAKE=1`) runs the same wiring with the SDK's fake chat adapter, which plays what each
case expects: no Model is called and no key is needed. Use it to check the script works. Its scores
mean nothing.

```sh
EVAL_DATABASE_URL=... pnpm -F @ai-chat/evals eval:turn -- --fake
```

## Queue evals (batching, interrupting, and refusals and questions)

The same run also plays six cases of the Router and queue (spec #510, #531) with the real `bot` plugin and
client ids, `EVAL_REPEATS` times each. Each has a structural check and an LLM-judge check:

- **batching:** "Plan a dinner." / "For 4 people." / "Vegetarian." sent 200 ms apart. Structural:
  exactly one Turn took all three Triggers, completed and sent a reply. Judge: the reply keeps all
  three (it plans the dinner, or asks a clarifying question that keeps them, #575).
- **interrupting:** "Plan a trip to Paris", then, once the Turn's job is running, "Actually, make it
  Rome". Structural: the first Turn ended `stopped`, a second Turn took the correction, completed and
  sent a reply. Judge: the reply plans a trip to Rome, or asks a clarifying question about it, and
  not about Paris (#575). The case asks for something the Bot can answer in a message: asked to book a meeting, which it has no tool for, the Model answered in
  plain text, which the user never sees (#516).
- **unavailable:** "Book the meeting for Thursday", which the Bot has no tool for. Structural: one Turn
  took the Message, completed and sent at least one Message (a refusal or a question goes through
  SendToUser too, never as plain text, #516). Judge: the reply says it cannot book or asks for details,
  and does not claim the meeting is booked.
- **no-email:** "Send this summary to my boss", which the Bot cannot do. Structural: as for unavailable.
  Judge: the reply says it cannot send email, and does not claim it sent anything. The prompt tells the
  Bot to start with the refusal and never offer to send anything to anyone but the user (#575).
- **unclear:** "Fix it", with no earlier context. Structural: as for unavailable. Judge: the reply asks
  what "it" is.
- **no-live-data:** "What's the weather in Delhi right now?". Structural: as for unavailable. Judge:
  the reply says it cannot look the weather up, and makes up no forecast. The Bot has `web_search`
  (#592), but the eval user has no Tavily key, so the tool answers that search is not set up (#598).

The four refusal and question cases (unavailable and the three above, #531) are the ones a Model once
answered in plain text, which the user never sees.

In the `--fake` run, the interrupting case's first Model call is held until the correction stops that Turn, so the fake cannot finish it first; real runs are not held.

The structural check reads Turns and Triggers, never the Model's text. The judge answers `Verdict:` and
`Reason:`, both printed per run and saved in the results file. `EVAL_JUDGE_MODEL` (an `openai:`,
`anthropic:` or `openrouter:` Model) sets the judge; it defaults to `EVAL_BOT_MODEL`, so that must be one of those
Providers unless you set it. `--limit` limits only the week-one cases.

## Routine and Check-in evals (spec #543, #550)

Six more cases play after the queue cases, `EVAL_REPEATS` times each, with the real `bot` plugin. The
first three start from a user Message. The last three start from a Trigger, handed to the Router the way
a Routine's fire or a fired Check-in does (`routineSnapshot` and `checkInNotice` make its text), after
the same kind of seeded history. The Bot has no tool to look anything up, so a Routine's prompt carries
the data it reads. Each case has a structural check on the Turn's tool calls and Messages, and most have a
judge check (same judge as above):

- **routine-recurring:** "Every weekday at 8am, give me a short summary of the top tech news."
  Structural: `create_routine` called. Judge: reads the call, a slug name, a prompt for the summary,
  mon to fri at 08:00.
- **routine-one-off:** "What's the capital of Australia?". Structural: `create_routine` not called, and
  a Message sent. No judge.
- **routine-check-back:** "I sent the contract to Priya. Check back with me Thursday." Structural:
  `set_check_in` called and `create_routine` not. Judge: reads the call, whose `at` is a Thursday
  (the weekday is computed and shown to the judge) and whose note mentions the contract or Priya.
- **routine-run-nothing-new:** a Routine run whose prompt shows the same versions today as yesterday.
  Structural: the Turn completes and sends no Message. No judge.
- **routine-run-something-new:** the same with vite at a new version. Structural: exactly one Message.
  Judge: it reports the new vite version and not a react one.
- **check-in-fired:** a Check-in whose note says to ask whether Priya replied. Structural: at least one
  Message. Judge: it asks about the reply or offers a reminder.

Results are saved as `routineRates` and `routineRuns` in the results file. Run the whole script, as above:
the same `--fake` dry run plays these cases too.

## Judge Model and results

- **Use a stronger judge than the Bot.** Set `EVAL_JUDGE_MODEL` to a different, stronger Model than
  `EVAL_BOT_MODEL` (it can be another Provider: the run reads that Provider's key, such as
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). A small Model judging its own replies once misread the
  routine-run-something-new criterion.
- The tally prints `judge n/a` for a case with no judge check, and the judge rate is over the judged
  runs only.
- Every run in the results file has `toolCalls`, the tool calls of its Turn(s) in order with their
  arguments (week-one, queue and routine runs), so a run that sent nothing shows whether the Bot called a
  tool or nothing at all.

## Ladder evals (spec #587, #598)

Five cases of the main agent's cheapest-first ladder, with the `computer` plugin on so the Turn has
the Computer system prompt and the Helper tools. They run in their own script, because the Computer
changes the prompt and tools of every Turn:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval EVAL_BOT_MODEL=openai:gpt-5.4-mini EVAL_JUDGE_MODEL=anthropic:claude-haiku-4-5 OPENAI_API_KEY=... ANTHROPIC_API_KEY=... pnpm -F @ai-chat/evals eval:ladder
```

`EVAL_BOT_MODEL`, `EVAL_JUDGE_MODEL`, `EVAL_REPEATS`, `EVAL_CONCURRENCY`, `--limit=<n>` and `--fake` work as
above. No Computer or E2B is needed: a Helper the Bot starts never runs (its job is queued a day on),
the Computer is a provider that fails every call, and the eval answers Tavily itself, so the run scores
only the main agent's choice. Each case has a structural check on the Turn's `start_helper` calls and
Messages, and a judge check (same judge and results file format as above, saved as
`src/turn/results/ladder-<time>.json`):

- **quick-question:** "What's the capital of Australia?". Structural: no `start_helper` call, at least
  one Message. Judge: the reply says Canberra.
- **research-task:** five standing desks under 30,000 rupees, compared and saved to a file, after an
  earlier exchange where the user said they are in Pune. Structural: exactly one `start_helper`, a
  `general` one. Judge: reads the task and checks it stands alone (the goal, the limit and the Pune
  delivery, which only the earlier exchange says).
- **website-task:** the movies showing on bookmyshow.com in Pune this weekend. Structural: exactly one
  `start_helper`, a `computer_use` one. Judge: the task names the site, the city, the weekend and what
  to report.
- **helper-report:** a `helper` Trigger with a General Helper's report of three desks. Structural: no
  `start_helper`, exactly one Message. Judge: the Message gives the useful result from the report and
  invents nothing.
- **broken-tool:** a live score, with the user's Tavily key missing, so `web_search` says it isn't set
  up. Structural: no `computer_use` `start_helper` call, at least one Message. Judge: the reply tells
  the user it cannot look it up and asks what to do, and makes up no score.

## Context engineering evals (spec #665, #678)

Three evals of Bot step 8, in their own script (`src/turn/context.ts`) because they use the `bot` and
`memory` plugins together and a direct Anthropic key:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_context EVAL_BOT_MODEL=anthropic:claude-haiku-4-5 EVAL_JUDGE_MODEL=anthropic:claude-sonnet-4-5 ANTHROPIC_API_KEY=... pnpm -F @ai-chat/evals eval:context
```

`EVAL_BOT_MODEL`, `EVAL_JUDGE_MODEL`, `EVAL_REPEATS`, `EVAL_CONCURRENCY` and `--fake` work as above.
`--only=cache,summary,tools` runs some of the three. `EVAL_REPEATS` defaults to 1 for the cache and
Summary evals (each is big) and 3 for the tool search cases. The cache eval fails at start unless
`EVAL_BOT_MODEL` is an `anthropic:` Model. Use a fresh `EVAL_DATABASE_URL` database
per run. Results are saved as `src/turn/results/context-<time>.json`, with each run's usage rows,
Summary text, replies and tool calls.

On a ChatGPT plan, the summary and tool search evals run with no key (see "On a ChatGPT plan" above
for the variables). The cache eval stays on a direct Anthropic key, since the plan caches nothing
(#664), so run it on its own:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_context EVAL_BOT_MODEL=openai:gpt-6.1-sol EVAL_JUDGE_MODEL=openai:gpt-6.1-sol EVAL_CHATGPT_USER_ID=<your user id> DATABASE_URL=... BETTER_AUTH_URL=... BETTER_AUTH_SECRET=... CHATGPT_CLIENT_ID=... CHATGPT_HOST_ID=... pnpm -F @ai-chat/evals eval:context --only=summary,tools
```

- **cache:** a scripted Conversation of four user Messages and a Routine's run, a memory line added
  twice between Turns, then a warm that is due (the Bot's usage rows are made two hours old and
  `warmBot` runs), then one more Turn. Structural, from the user's `turn` and `warm` usage rows: no call
  has a `bug` flag in `prompt_hashes`; every Turn call after the first reads at least 80% of the
  Prompt start's estimated size (`tools`, system blocks, `first_message`) from the cache, unless it
  is flagged `expected`; `warmBot` returns `warmed: true` and its `warm` row wrote or read the cache
  with no output. That last part is the check of the Anthropic `max_tokens: 0` warming call (#677),
  which no test has run against the real API: a rejection shows as `warmBot` skipping with
  `unavailable` and a logged error ("Warming the cache of Bot ... failed").
- **summary:** the Bot is told three facts (a dog's name, a flight number, a budget), then filed 45
  pasted notes of 12,000 characters (about 120,000 tokens, over the away Summary's 100,000). One more
  Turn ends over the threshold and queues the away Summary; the eval brings that job forward (it
  waits 10 minutes otherwise) and waits for the Summary. Structural: a Summary is written, its text
  holds the Bot's last 3 Messages to the user word for word, and a Turn that asks for the three facts
  answers with all of them. Judge: the reply gives all three correctly. The mid-Turn Summary
  (0.75 of the context window) is covered by the integration tests, not this eval.
- **tool-reminder, tool-routine, tool-helper:** "remind me on Friday to renew my passport", "every
  Monday at 9am send me my priorities" and "how is that desk research going?" (a running Helper is
  seeded). Structural: `describe_tool` is called for `set_check_in`, `create_routine` or
  `check_helper`, then `run_tool` with that name, the call is not an error, it is not called
  directly, and the right row is there: a Check-in, a Routine, or the seeded Helper's task in
  `check_helper`'s result.

`--fake` plays a scripted Model instead of a real one. It proves the wiring and the scoring (the
cache numbers are the script's own), not the cache or the Model.

### Results

The summarize instruction (`summarizeInstruction` in `plugins/bot/server/summary.ts`) and the
tool-name list in the Prompt start are tuned until these pass. Record each run here.

**2026-10-21, ChatGPT plan, `openai:gpt-6.1-sol` (Bot and judge), `--only=summary,tools`:**

- **First run:** summary 0/1, tool-reminder 0/3, tool-routine 3/3 and tool-helper 3/3.
  - **Summary:** `seedHistory` stored the seeded Turns with no `input`. A Turn with no `input` reads
    as one from before inputs were stored, so its user Messages were never rendered, and the Turn
    sent about 5k tokens instead of 120k. It now stores the input a real Turn stores.
  - **tool-reminder:** the Bot used `create_routine`, with a prompt that deletes itself after one
    run. The one-line summaries now say a Routine repeats and is "never a one-time reminder", and
    that a Check-in is "a one-time reminder or wake-up". The Routine rule in the system prompt points
    one-time reminders at `set_check_in`.
- **After those fixes:** summary 1/1 (judge 1/1), tool-reminder 3/3, tool-routine 3/3 and
  tool-helper 3/3. Results: `context-2026-10-21T05-45-41-242Z.json`.

**cache: not run yet.** It needs a direct Anthropic key, because the plan caches nothing (#664).
