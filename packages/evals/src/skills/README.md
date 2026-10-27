# Skills evals

Hand-run scores for a Bot's Skills (spec #713, ticket #721). They are not in CI and are not part of the SDK a Host
copies. Everything is scored deterministically, with no judge: from the Turn's tool
calls, the Messages the Bot sent, and the `SKILL.md` files left on its Computer.

- **`eval:skills`**: real Turns on a real Model, through the real `bot` and `skills` plugins, on the
  SDK's fake Computer seeded with Skills. 41 cases in three groups: Use, Save, Follow and fix.
- **`eval:skills:draft`**: the drafting pass (`draftSkill`, #720) called directly, with no Turn, on 3
  checked-in fixture Demonstrations.

## Run them

Both need a scratch Postgres, created before the first run (the scripts migrate it, but
do not create the database), and a Model key:

```sh
EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_skills \
OPENROUTER_API_KEY=... \
pnpm -F @ai-chat/evals eval:skills

EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_skills \
OPENROUTER_API_KEY=... \
pnpm -F @ai-chat/evals eval:skills:draft
```

- `EVAL_BOT_MODEL` is the Bots' Model (and the drafting pass's), a `"provider:model"` id (default
  `openrouter:anthropic/claude-sonnet-5.5`). The key variable is the Provider's (`OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`).
- `EVAL_CHATGPT_USER_ID` (with the web app's settings, as in "On a ChatGPT plan" in
  `src/turn/README.md`) runs a plan Model on that user's linked plan instead of `OPENAI_API_KEY`
  (ADR 0023). On the owner's plan:

  ```sh
  EVAL_CHATGPT_USER_ID=<user id> EVAL_BOT_MODEL=openai:gpt-6.1-sol \
  EVAL_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval_skills \
  pnpm -F @ai-chat/evals eval:skills
  ```

  Also set the web app's own `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `CHATGPT_CLIENT_ID` and `CHATGPT_HOST_ID` (from `apps/web/.env`), as for the other evals.

- `EVAL_REPEATS` runs each case that many times (default 1), `EVAL_CONCURRENCY` that many `eval:skills`
  runs at once (default 4; the drafting eval runs one at a time).
- `--limit=<n>` runs the first n cases and `--group=use|save|follow-fix` only that group (`eval:skills`).
- With no key set they exit 1 at once, saying so. `-- --fake` (or `EVAL_FAKE=1`) runs the same wiring
  with the SDK's fake chat adapter, which plays each case's scripted tool calls (or a good drafted
  Skill): no Model or key is used, and its all-pass only shows the scripts work.
- A Turn's risky shell commands are still reviewed by the Auto-review on the Bot's own Model, as in
  production, so a real run makes a review call per such command.

They print pass or FAIL per run with the reasons, and exit 1 unless every run passed. Every run's tool
calls, Messages and Skills (or drafted `SKILL.md`) are saved to
`src/skills/results/skills-<time>.json` and `skills-draft-<time>.json` (gitignored).

## `eval:skills` cases

Each case is a fresh user and Bot on the fake Computer. The Use cases start with eight Skills in three look-alike pairs (weekly / monthly metrics, payouts / refunds to a sheet, candidate sourcing / outreach) and two single ones (receipts, meeting notes); the Save cases start with none; each Follow and fix case names its own Skill.

| Group      | Cases | Passes when                                                                                                                                                                                                                                                                          |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use        | 20    | 8 covered messages: the Bot reads that `SKILL.md` before its first acting call, and no other. 4 close to a look-alike: the right one, not the look-alike. 8 with no Skill: it reads none.                                                                                            |
| Save       | 15    | 8 explained repeatable tasks or "remember how": a valid Skill with the task's key words is saved and the Bot says so. 3 one-offs and 2 webhook payloads: none saved. 2 long repeatable tasks: saving unasked is measured, not required, but a saved one must be valid and announced. |
| Follow/fix | 6     | 3 follow: a Skill's non-obvious rule (the `reports/YYYY-MM/` folder, the CC address, the CSV name) is in a tool call's arguments. 3 fix: a stale path makes the Bot `edit` the Skill and tell the user.                                                                              |

A Skill is read by a `read` of its `SKILL.md` or a read-only shell command on it (`cat`, `head`...). An
acting call is any other tool call except `list`, `send_to_user`, `describe_tool` and `search_memory`.

It prints three rates over the Use cases:

- **hit**: the right Skill was read before the first acting call (of the 12 covered cases);
- **wrong Skill**: another Skill was read as well as, or instead of, the right one (same 12);
- **needless read**: a Skill was read when none fits (of the 8 no-Skill cases).

It also prints how often the Bot saved a Skill unasked after a long repeatable task.

The fake Computer fails a shell command that names `export-payouts-v1` or `exports-old` (a stale
Skill's path) with "No such file or directory", in every case; no other case's commands name them.

## `eval:skills:draft`

The 3 fixture Demonstrations are in `src/skills/fixtures/<id>/`: `events.json` (the goal, the inputs
and each step as the capture stores it) and one PNG per screenshot, 168 KB in all.

**They did not come from the real Computer.** There was no E2B or Screen when they were made, so
`record-fixtures.ts` recorded them with the real capture code (#719) against a real local headless
Chromium, driving small scripted pages the way `bot-demonstration-capture.integration.test.ts` does.
The local address was rewritten to a made-up host (`dashboard.example.com`...). Run
`pnpm -F @ai-chat/evals eval:skills:record` to record them again (it needs `EVAL_DATABASE_URL` and a
Chromium that Playwright can launch). Re-record on the real Computer when you can: the drafting prompt
is the thing under test, and the steps and screenshots are what a Screen's Chrome would report.

For each fixture the eval writes a Demonstration and its events into the scratch database, runs the
real `draftSkill`, then `draftedSkill` (which checks the reply as the Skills block does), and scores:

| Fixture             | Inputs named              | Pages named                                                 | Labels named                               |
| ------------------- | ------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `payouts-to-sheet`  | the week                  | `dashboard.example.com/payouts`, `sheets.example.com/sheet` | Export CSV, Paste payouts, Save sheet      |
| `download-invoice`  | the month                 | `billing.acme-vendor.example/login`, `.../invoices`         | Email, Password, Sign in, Download invoice |
| `book-meeting-room` | room, date, who is coming | `rooms.example.com/rooms`                                   | Room, Date, Attendees, Book room           |

It also passes only if the frontmatter is valid and its description starts "Use this when", and if the
Skill never contains the mask `••••••••` or the password the user typed (`download-invoice`'s
password field is stored masked with no screenshot, and its plaintext is not in the fixture).

## Manual demo

The full path, from watching to doing, is not automated. On the real Computer (local E2B or the Host's):

1. Tell a Bot "let me show you how I do <a browser task>"; give it the goal and what changes each time.
2. In the Show me card, do the task once in the Screen's browser. Press Pause before a sign-in, then
   resume. Check each step appears in the "What <Bot> sees" list. Press Done.
3. Open the Skill the Bot saved (the Skill chip, or the Skills popover). Check: valid name and a
   "Use this when" description; the inputs named; the steps name the real pages and the fields' labels;
   no password or other secret anywhere.
4. Ask the Bot for the task again with a new input value. Check it reads the Skill, hands the steps and
   the new value to a Computer-use Helper, and that the Helper does the task on the Screen.
5. Break something in the Skill (a path, a label) and ask again: the Bot should fix the Skill and say so.

## What it costs

`eval:skills` is 41 Turns, each a few model calls of a few thousand input tokens, plus an Auto-review
call per risky shell command: on the order of a million tokens. `eval:skills:draft` is 3 calls with up
to 7 screenshots each. They are billed on your key or plan. Run them deliberately.

## Results

First real run: 2026-10-21, commit ecd95364, on the owner's ChatGPT plan (`EVAL_CHATGPT_USER_ID`),
1 repeat.

| Eval                | Model                | Result                                       |
| ------------------- | -------------------- | -------------------------------------------- |
| `eval:skills`       | `openai:gpt-6.1-sol` | 37/41: use 20/20, save 15/15, follow-fix 2/6 |
| `eval:skills:draft` | `openai:gpt-6.1-sol` | 3/3                                          |

- **Use:** hit 100% of 12 Skill cases, wrong Skill 0%, needless read 0% of 8 no-Skill cases.
- **Save:** saved unasked after a long repeatable task in 2 of 2 runs.
- **Follow-fix:** `follow-cents` and `follow-cc-finance` pass. The three `fix-*` cases fail the same way:
  the stale command fails, and the Bot asks the user for the new path instead of looking for the
  renamed file (it is on the Computer) and editing the Skill. `follow-month-folder` failed because the
  Bot never read `weekly-metrics-email`.

After #736 (the fix rule now says to look for a renamed file before asking), `--group=follow-fix` on
`openai:gpt-6.1-sol`, 2026-10-22, 1 repeat: **4/6**. All three `fix-*` cases now find the renamed file
and edit the Skill; `fix-script-path` still failed once on not telling the user, and
`follow-month-folder` still never read its Skill.
