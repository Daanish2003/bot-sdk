---
Status: accepted
---

# Host credentials with per-user Quotas

ADR 0003 rejected server keys: every run was paid for with the user's own Provider credentials. A Chat SDK in production for real users needs the opposite too. `apps/web` wants a free tier on its own key, and a company Host wants only its own keys and its own plans, with no user keys at all. ADR 0003 still holds for the user's own credentials (encrypted at rest, never readable by the client, no TanStack client BYOK); this ADR replaces only its "the app holds no keys of its own".

- **Two independent `createChat` options.** `hostProviders?: [{ provider, credentials, models[] }]` are the Host credentials, passed in from the Host's environment and never stored in the database. They also cover Tools (a Host Tavily key, with a fixed price per search), and every Host Model needs a `maxOutputTokens`. `byok?: boolean` (default `true`) allows the user's own Provider credentials. `start()` refuses a config with neither. With `byok: false` the keys page and "add your key" prompts are hidden and credential writes are rejected.
- **The user's own credentials win.** If a user has Provider credentials for a Provider, runs on it use them and are never metered. The Model picker shows which Models run on Host credentials.
- **The Quota is measured in money.** Each call on Host credentials (a Run, a title, a web search) writes a row to `chat.usage` (`user_id`, `kind`, `model`, token counts, `cost_micros`, `estimated`, `created_at`). Cost comes from the Provider when it reports one (OpenRouter), otherwise from token usage times the Model's price, otherwise from an estimate (characters ÷ 4) when usage is missing. The table is separate from Messages so that deleting a Conversation gives no quota back. `deleteUser` removes the rows.
- **The Host decides the amount.** `getQuota(userId) → { budgetUsd, window: 'day' | 'month' } | null`, with a fixed value accepted as shorthand; `null` is unlimited. Windows are fixed UTC days or calendar months. Plans and payments, if a Host has them, live behind this callback.
- **Checked before a Run, never mid-stream.** A Run on Host credentials is refused once the window's spend reaches the budget; a started Run finishes, so it can go over by at most one Run's bounded cost.

  _Amended 2026-10-12 ([#185](https://github.com/Daanish2003/ai-chat/issues/185)): every paid tool call on Host credentials (a web search, a Generated image) is also checked before it runs. Over the budget, that call fails with `quota_exceeded`, the Model is told why, and the Run carries on, so no reply is cut off. A Generated image can cost about $0.25, and a Run that makes several can't be bounded by the check before the Run alone._

  _Amended 2026-10-12 ([#235](https://github.com/Daanish2003/ai-chat/issues/235)): transcribing a voice recording on Host credentials, which happens outside any Run, is checked the same way before it runs; over the budget it is refused and the mic shows the reset time. It is metered as a `transcription` usage row, priced per minute from the Host's own price for the Model (the TanStack adapters report no cost), using the duration the Provider reports or else the recording's length._

- **What the user sees.** A meter on the composer from 80% (percentages, never money); at the limit the composer is disabled for Host Models with the reset time, an "Add your own key" prompt when `byok` is on, and a Host-rendered `quotaExceeded` slot for plans.
- **Rate limits are separate from Quotas.** The SDK limits Run starts, Attachment uploads, credential saves and checks, and Conversation search per user, and Shared link views per IP, with default limits the Host can override. Counters live in the `runtime` (ADR 0006): in memory for `memoryRuntime()`, Redis for `redisRuntime()`. Over the limit is HTTP 429 with `Retry-After`. Sign-up, sign-in and password reset stay the Host's (Better Auth's limiter, on Redis storage, in `apps/web`).

## Considered Options

- **Count Runs or tokens instead of money**: simpler and independent of price data, but Models differ in price by about 100× and a long Conversation costs far more than a short one.
- **A fixed quota in config only**: no seam for a Host's plans.
- **Host credentials until the Quota runs out, then the user's**: spending moves to the user's bill without them noticing.
- **Reserve cost up front and stop a Run when the budget runs out**: exact, but cuts replies off mid-sentence.
- **Usage columns on Messages**: deleting a Conversation would refund the Quota.
- **Rate-limit counters in Postgres**: durable, but high-churn writes for data that lives seconds.

## Consequences

- A new `chat.usage` table (schema change) and the SDK must sum usage from every `RUN_FINISHED` (see the token usage research), plus keep a price per Host Model.
- Usage is best-effort, so the Quota is approximate: stopped and failed Runs are estimated.
- Host credentials are rotated by redeploying with new environment values; nothing at rest changes.
