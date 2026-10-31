# What a Model switch costs, and which errors are failover-worthy

Research for #1093 (part of the Model routing map #1091). Researched on 2026-10-31.

How to read the sources:

- **Repo code.** Paths are relative to the repo root, at `ec9ff13c` (main).
- **Installed packages.** `@tanstack/ai` 1.0.0, `@tanstack/ai-anthropic` 1.0.0, `@tanstack/ai-openai` 1.0.0 (on `@tanstack/openai-base` 1.0.0), `@tanstack/ai-gemini` 1.0.0, and the SDKs under them: `@anthropic-ai/sdk` 0.135.0, `openai` 7.30.0, `@google/genai` 2.27.0. Paths like `ai-anthropic/src/...` are inside `node_modules/.pnpm/<pkg>/node_modules/@tanstack/...`.
- **Provider docs.** Fetched live on 2026-10-31: Anthropic [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [errors](https://platform.claude.com/docs/en/api/errors); OpenAI [pricing](https://developers.openai.com/api/docs/pricing), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [error codes](https://developers.openai.com/api/docs/guides/error-codes); Gemini [pricing](https://ai.google.dev/gemini-api/docs/pricing), [caching](https://ai.google.dev/gemini-api/docs/caching), [API errors](https://ai.google.dev/gemini-api/docs/api-errors) and [troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting).
- **Unverified.** Nothing here was run against a live Provider. Latency figures are estimates, marked as such.

---

## Answer in short

1. **A switch costs one cold write of everything before the newest message, priced at the _destination_ Model's cache-write rate.** At a mid-Conversation prompt of 50k tokens, that is about $0.39 on Claude Opus 5.5, $0.20 on Sonnet 5.5, $0.12 on gpt-6.1-sol, $0.09 on Gemini 3.1 Pro, and under a cent on Haiku 5.5 or gpt-6-luna. That is roughly 15 to 40 times the cache read the same Step would have cost on the warm Model. Switching _down_ to a cheap Model is nearly free. Switching _up_ is what costs money.
2. **Stickiness: keep the owner's rule (stay until the Task kind changes), and add free switch points.** A switch is free after a Summary (the new Prompt start is cold for every Model), after the cache lifetime has passed since the last call (1 hour on Anthropic, 30 minutes on OpenAI, per `warm.ts`), and at a reset. See §3.
3. **Fail over on capacity errors only:** rate limits that carry a wait, overloaded, 5xx, timeouts, connection errors, and mid-stream server failures. **Never fail over** on bad credentials, permission, billing or spend caps, invalid requests, context overflow (a Summary handles it), refusals or safety blocks, `max_tokens`, or an abort. The table is in §5.
4. **TanStack AI 1.0 surfaces Provider errors as a yielded `RUN_ERROR` chunk, not a throw.** The fields are inconsistent across adapters. Gemini's adapter drops the HTTP status entirely, and the Bot loop today keeps only `chunk.message`. Failover needs a small classifier in the SDK, described in §6.

---

## 1. How big is a Bot's prompt?

### The Prompt start, measured

The Prompt start (CONTEXT.md: tools, system prompt, and a first message that stay the same until the next Summary) is built in `packages/botsdk/bot/src/bot/context/prompt-start.ts` and `context.ts` (`startParts`). It does not depend on the Model or Provider. `context.ts` never branches on the Provider, so after a switch the same Prompt start text goes to the new Model, and only that Provider's cache is cold.

I measured it with a throwaway integration test (not committed). The test ran one Turn through `createTestSdk` with the fake adapter and read `fake.calls[0]`:

| Bot setup                             | Tools sent | Tool definitions (JSON chars) | System blocks (chars) | First message (chars) | Total chars | ≈ tokens (chars ÷ 4) |
| ------------------------------------- | ---------- | ----------------------------- | --------------------- | --------------------- | ----------- | -------------------- |
| Bare (no Computer, Memory, Knowledge) | 4          | 4,045                         | 1,535                 | 1,479                 | 7,059       | ~1.8k                |
| Computer + Memory + Knowledge         | 11         | 8,044                         | 4,826                 | 2,720                 | 15,590      | ~3.9k                |

On top of that, each Provider adds overhead. Anthropic adds a tool-use system prompt of 286 tokens on Opus/Sonnet 5.5 (497 on Sonnet 4.6), per the pricing page. Claude 4.7+ tokenizes the same text into about 30% more tokens (also per the pricing page). JSON schemas also tokenize denser than prose. **So the Prompt start is about 2k to 5.5k tokens**, plus Custom Rules, Skills and Routines when a Bot has them.

### Everything before the newest message is cached, not just the Prompt start

What a switch loses is more than the Prompt start. Anthropic's breakpoints are on the last system block, the first message, and the automatic request-level breakpoint (`packages/botsdk/bot/src/models/cache-control.ts`). OpenAI and Gemini cache the longest matching prefix. Either way, the cached part is the whole prompt up to the newest message: Prompt start plus the Conversation so far. That grows until a Summary:

- A mid-Turn Summary fires past `summaryThreshold = 0.75` of the context window (`packages/botsdk/bot/src/bot/agent-loop/loop.ts:193`).
- An away Summary is queued once a Turn's last Step input passes `awaySummaryTokens = 100_000` (`packages/botsdk/bot/src/bot/context/summary.ts:25`).

So the prompt sizes to price are about **5k** (new Conversation), **50k** (an active Conversation), and **150k** (a long one, near the away-Summary point).

I found no real usage rows to check this against. The local `ai-chat` database has no `botsdk.bot_prompt_start` or `botsdk.usage` rows.

---

## 2. What a cache miss costs

### Provider cache rules

| Provider                      | What the Bot sends                                                                                                | Minimum cacheable                                          | Write price                                                                                           | Read price                                       | Lifetime                                                    | Per Model?                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Anthropic                     | 1-hour breakpoints (`ttl: "1h"`) on the last system block, the first message and the request (`cache-control.ts`) | 512 tokens on the 5.x Models; 1,024 to 4,096 on older ones | **2×** input for 1h (1.25× for 5m)                                                                    | 0.1× input; **0.05×** on Opus 5.5 and Sonnet 5.5 | Refreshed free on every hit; counted from request start     | Not stated. Caches are isolated per organization/workspace; **assume per Model** (unverified) |
| OpenAI (and the ChatGPT plan) | `prompt_cache_key: bot:<botId>` (or `helper:<id>`), no retention                                                  | 1,024 visible tokens (GPT-5.6+)                            | **1.25×** for the default 30-minute minimum (2.5× for 12h), GPT-5.6+; no write charge on older Models | 0.1×; **0.05×** on gpt-6.1-sol and -terra        | 30m minimum (GPT-5.6+); 5 to 10 min idle on older in-memory | **Yes**: "Cache entries are tied to the model"                                                |
| Gemini                        | **Nothing**: `withCacheControl` returns Gemini options unchanged, so only implicit caching applies                | 4,096 tokens on Gemini 3.x/4; 2,048 on 2.5                 | None for implicit caching                                                                             | 0.1× (e.g. 3.6 Flash $0.075 vs $0.75)            | Not documented for implicit caching                         | Not stated                                                                                    |

Two Gemini notes:

- **Small Bots miss on Gemini.** A bare Bot's ~2k-token Prompt start is below Gemini 3.x's 4,096-token minimum. A Bot on Gemini gets no cache until its history grows past that.
- **Short Steps re-process the tail.** On Gemini 4, "Gemini caches the full previous request only if the new request adds at least 2,050 tokens". Agent-loop Steps that add a short tool result re-process the last 2,050 tokens at full price.

### Extra cost of one switch

This is the extra cost of the first Step on the new Model compared with staying on a warm one. The formula is prompt × (destination write price − destination read price). Prices are per MTok, from the pricing pages fetched on 2026-10-31.

| Destination Model      | Write used              | Read   | 5k prompt | 50k prompt | 150k prompt                                  |
| ---------------------- | ----------------------- | ------ | --------- | ---------- | -------------------------------------------- |
| Claude Opus 5.5        | $8 (1h)                 | $0.20  | $0.039    | **$0.39**  | $1.17                                        |
| Claude Sonnet 5.5      | $4 (1h)                 | $0.10  | $0.020    | **$0.20**  | $0.59                                        |
| Claude Sonnet 4.6      | $6 (1h)                 | $0.30  | $0.029    | $0.29      | $0.86                                        |
| Claude Haiku 5.5       | $0.20 (1h)              | $0.01  | $0.001    | $0.0095    | $0.14 (the >100k tier: $1 write, $0.05 read) |
| gpt-6.1-sol            | $2.50 (30m)             | $0.10  | $0.012    | **$0.12**  | $0.36                                        |
| gpt-6-luna             | $0.125 (30m)            | $0.01  | $0.0006   | $0.0058    | $0.017                                       |
| gpt-5.4-mini (pre-5.6) | $0.75 (no write charge) | $0.075 | $0.0034   | $0.034     | $0.10                                        |
| Gemini 3.1 Pro (≤200k) | $2 (no write charge)    | $0.20  | $0.009    | **$0.09**  | $0.27                                        |
| Gemini 3.6 Flash       | $0.75 (no write charge) | $0.075 | $0.0034   | $0.034     | $0.10                                        |

For scale, take a warm Step on Sonnet 5.5 at 50k with 1k output tokens. It costs about $0.005 read plus $0.01 output, so $0.015. The switch Step costs about $0.21, roughly **14 warm Steps**. The Bot's Anthropic Steps pay the 1-hour write rate (2×), which makes a switch onto Anthropic about 1.6 times dearer than it would be at the 5-minute rate.

### Latency

No Provider documents a figure:

- Anthropic: "You generally see improved time-to-first-token for long documents", and the 5m and 1h caches behave the same.
- OpenAI: caching reduces "time spent processing input before the response starts"; no number given.
- Gemini: no claim.

**Estimate (unverified):** an uncached 50k-token prefill adds on the order of one to a few seconds to the first token of the switched Step. At 5k it is negligible. The spec's eval could measure this. OpenAI GPT-5.6+ `prompt_cache_options.prewarm` and Anthropic `max_tokens: 0` (both already used by `warm.ts`) could warm a destination ahead of time, but a Turn-start switch has nothing to warm ahead of.

---

## 3. Stickiness: recommendation

1. **Keep the charting rule:** a Conversation stays on its Model until the Task kind changes. A switch costs about 10 to 40 warm Steps on the destination, so per-message routing would pay that on every flip.
2. **Treat these moments as free switch points.** At each, the cache is cold for every Model, so the classifier's pick can be applied even with no Task-kind change:
   - **After a Summary.** It builds a new Prompt start, so nothing is cached for any Model.
   - **After the cache lifetime.** When the Bot's last model call is older than `cacheLifetimeMs` (`packages/botsdk/bot/src/bot/context/warm.ts:28`: 60 min Anthropic, 30 min OpenAI), the warm Model is cold too. `lastCallAt` in `warm.ts` already computes this.
   - **After a reset mark, or in a new Conversation.**
3. **The cost is asymmetric, so the rule could be too (optional).** Switching to a cheaper destination pays for itself on its first Step. Switching up pays the destination's full write. The plain Task-kind rule is enough for v1. A later classifier could weigh `prompt tokens × destination write price` against expected savings.
4. **Switching back within the lifetime is a partial hit.** Going A → B → A within an hour keeps A's cache of the prefix up to the first switch (Anthropic refreshes on hit; OpenAI keeps at least 30 min). Only the B-era messages are re-written. Docs don't promise this for Anthropic, which doesn't say caches are per Model (unverified).
5. **Failover always pays the miss.** It is unavoidable and rare, so it needs no stickiness. Do record it, so the next Turn decides whether to stay on the failover Model: it is now the warm one.

---

## 4. How Provider errors surface through TanStack AI 1.0

### Errors are yielded, not thrown

Every text adapter catches the SDK's error and **yields** a `RUN_ERROR` chunk; none throws out of `chatStream`. The `RunErrorEvent` fields (`ai/src/types.ts`, around line 1663) are:

- `message`
- `code`, "stays the HTTP status" (or a Provider code)
- `errorType` (e.g. `overloaded_error`)
- `retryAfterMs`, read from `retry-after-ms` or `retry-after` (`toRetryAfterMs`, `ai/src/activities/error-payload.ts`)
- `requestId`
- `rawEvent`, the Provider's error body (never the SDK exception)

Two other codes are shared: `CONTEXT_OVERFLOW_CODE = 'context_overflow'` and `aborted`.

### What the SDKs retry before the adapter sees anything

| SDK                       | Retries                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/sdk` 0.135 | 2 retries by default (`maxRetries ?? 2`) on 408, 409, 429 and ≥500, honouring `x-should-retry` and `retry-after`. Timeout 10 min. Mid-stream errors are not retried (`client.js` `shouldRetry`). |
| `openai` 7.30             | The same: 2 retries on 408, 409, 429 and ≥500 (`_OpenAI_normalizeRetries` defaults to 2). Timeout 10 min.                                                                                        |
| `@google/genai` 2.27      | **None by default.** It retries 408, 429, 500, 502, 503 and 504 only when `httpOptions.retryOptions` is set. `createGeminiClient` and `apps/web/src/model-providers.ts` set none.                |

So an Anthropic or OpenAI error that reaches the loop has usually already been retried twice. A Gemini 429 arrives on the first failure.

### Per adapter

**Anthropic** (`ai-anthropic/src/adapters/text.ts`):

- `code` is `err.code || String(err.status)`, with `context_overflow` when the status is 400 and the message contains "prompt is too long" (`runErrorCode`, line 2381).
- `errorType`, `retryAfterMs`, `requestId` and `rawEvent` are all forwarded.
- **A mid-stream SSE error** (such as `overloaded_error` after a 200) is thrown by the SDK as `new APIError(undefined, body, undefined, headers, type)` (`sdk/core/streaming.js:122`). The status is undefined, so **`code` is the string `"undefined"`**, and only `errorType` says `overloaded_error` or `api_error`.
- Connection errors and timeouts (`APIConnectionError`, `APIConnectionTimeoutError`) likewise give `code: "undefined"`, no `errorType`, and the message "Connection error." or "Request timed out."
- Stop reasons:
  - `max_tokens` gives `RUN_ERROR code: 'max_tokens'`.
  - `model_context_window_exceeded` gives `RUN_ERROR code: 'context_overflow'`.
  - **`refusal` is not an error.** It is `RUN_FINISHED finishReason: 'content_filter'`, with `rawEvent: stop_details`.

**OpenAI** (`openai-base/src/adapters/responses-text.ts`):

- `code` comes from `toRunErrorPayload`: the body's `error.code` when it is a string (e.g. `rate_limit_exceeded`, `insufficient_quota`, `invalid_api_key`), else the numeric status as a string (e.g. `"500"`). `context_length_exceeded` becomes `context_overflow` (`isContextOverflow`, line 1204).
- `errorType` is the body's `type`, forwarded along with `retryAfterMs`, `requestId` and `rawEvent`.
- A **`response.failed` event** gives a `RUN_ERROR` whose `code` is the `ResponseError.code`. That is one of `server_error`, `rate_limit_exceeded`, `invalid_prompt`, `bio_policy`, `misalignment_policy_violation`, `vector_store_timeout`, or one of the `invalid_image*` / `image_*` codes (`openai/resources/responses/responses.d.ts:2414`). This path carries **no `retryAfterMs`**.
- `response.incomplete` with no detail gives `code: 'incomplete'`. A stream that ends without a terminal event gives `code: 'incomplete-stream'`.
- **A refusal content part gives `RUN_ERROR code: 'refusal'`**. That is an error here, unlike on Anthropic.
- A connection error or timeout gives no `code` at all (no status, no body code).
- The ChatGPT plan's broken link gives `RUN_ERROR code: 'chatgpt_reconnect'` (`packages/botsdk/bot/src/models/chatgpt-plan.ts`).

**Gemini** (`ai-gemini/src/adapters/text.ts:484`):

- **`code` is set only for `context_overflow`.** That is detected from a 400 whose message matches `/input token count.*exceeds the maximum number of tokens/` (`utils/client.ts:77`).
- The adapter never calls `toRunErrorPayload`, so **the `ApiError.status` (429, 503, ...) is dropped**.
- No `errorType`, `retryAfterMs` or `requestId` is set. `rawEvent` is undefined because `ApiError` carries only `message` and `status`.
- What survives is the message. The SDK sets it to `JSON.stringify(errorBody)`, i.e. `{"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}` (`genai/dist/node/index.cjs:14094`). So it can be parsed.
- Finish reasons:
  - `MAX_TOKENS` gives `RUN_ERROR code: 'max_tokens'`.
  - **`SAFETY`, `RECITATION`, `PROHIBITED_CONTENT` and the rest end as `RUN_FINISHED finishReason: 'stop'`** (line 1215). A safety block looks like an empty, clean answer.

### What the Bot loop does with them today

- `packages/botsdk/bot/src/bot/agent-loop/loop.ts:977` keeps only `chunk.message` from a `RUN_ERROR` (`if (chunk.type === EventType.RUN_ERROR) error = chunk.message`). `code`, `errorType` and `retryAfterMs` are dropped.
- The chunks, including a `RUN_ERROR`, are recorded in the `model` activity (`ctx.step("model", ...)`, around line 513), so a replay plays the failure back.
- `liveChunks` wraps only _thrown_ errors in `ModelCallError`, and adapters don't throw.

So failover has to inspect the chunks inside the `model` activity, before they are recorded, and retry on the next Model there. Then a replay records the successful call, not the failure.

---

## 5. Failover-worthy versus never-failover, per adapter

"Fail over" means: retry this Step on the next Model in the Model rule (after the SDK's own retries already failed). "Never" means: end the Step as today, with an error the user sees.

| Class                           | Anthropic (as surfaced)                                                                                                     | OpenAI (as surfaced)                                                                                                                                                  | Gemini (as surfaced: parse `message` JSON)                                | Verdict                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Rate limit (transient)          | `code "429"`, `errorType rate_limit_error`, **with** `retryAfterMs`                                                         | `code rate_limit_exceeded` (HTTP 429, or `response.failed`); `slow_down`                                                                                              | `429` / `RESOURCE_EXHAUSTED`, `rate_limit_exceeded` / `too_many_requests` | **Fail over**                                                                                                        |
| Overloaded / unavailable        | `code "529"` or mid-stream `code "undefined"` with `errorType overloaded_error`                                             | `code "503"` / `server_is_overloaded`                                                                                                                                 | `503` / `UNAVAILABLE`                                                     | **Fail over**                                                                                                        |
| Server error                    | `code "500"` / `api_error` (also mid-stream)                                                                                | `code "500"` (no body code), `response.failed` `server_error`                                                                                                         | `500`, `502`                                                              | **Fail over**                                                                                                        |
| Timeout                         | `code "504"` / `timeout_error`; `"undefined"` + "Request timed out."                                                        | `code "408"`/`"504"`; no code + timeout message                                                                                                                       | `408`, `504` / `DEADLINE_EXCEEDED`                                        | **Fail over**                                                                                                        |
| Connection error, broken stream | `code "undefined"`, no `errorType`, "Connection error."                                                                     | no `code`; `incomplete-stream`                                                                                                                                        | no `code`, non-JSON message                                               | **Fail over** (not when aborted)                                                                                     |
| Spend cap / credits exhausted   | `429` **without** `retry-after` (tier spend cap); `400 invalid_request_error` at a spend limit you set; `402 billing_error` | `429` with `insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` | `402` `payment_required`; `429` `quota_exceeded` (daily)                  | **Never on the same credential.** Whether to skip to a Model on another credential (e.g. Host) is a decision, see §7 |
| Bad credentials, permission     | `401 authentication_error`, `403 permission_error`                                                                          | `401` (`invalid_api_key` etc.), `403`; `chatgpt_reconnect`                                                                                                            | `401`, `403` `PERMISSION_DENIED`                                          | **Never** (charting rule)                                                                                            |
| Invalid request                 | `400 invalid_request_error`, `413 request_too_large`, `404 not_found_error`                                                 | `400`, `404`, `422`; `invalid_prompt`, `invalid_image*`                                                                                                               | `400` `INVALID_ARGUMENT`, `404` `model_not_found`, `416`, `501`           | **Never** (charting rule). Possible exception: a 404 retired Model, see §7                                           |
| Context too long                | `context_overflow` (400 "prompt is too long", or stop reason `model_context_window_exceeded`)                               | `context_overflow` (`context_length_exceeded`)                                                                                                                        | `context_overflow` (400 message match)                                    | **Never.** Summarize and retry on the same Model; the loop already summarizes at 75%                                 |
| Refusal / safety                | `RUN_FINISHED finishReason content_filter` (not an error)                                                                   | `RUN_ERROR code refusal`; `bio_policy`, `misalignment_policy_violation`                                                                                               | `RUN_FINISHED 'stop'` (adapter hides it)                                  | **Never** (charting rule)                                                                                            |
| Output cap                      | `max_tokens`                                                                                                                | `incomplete` (max output)                                                                                                                                             | `max_tokens`                                                              | **Never** (not a Provider failure)                                                                                   |
| User abort / Turn stopped       | `aborted`                                                                                                                   | `aborted`                                                                                                                                                             | aborted signal                                                            | **Never**                                                                                                            |

Two detection rules fall out:

- **The 429 split.** On Anthropic, a 429 **with** `retryAfterMs` is a rate limit, and one **without** it is a spend cap. On OpenAI, the `code` string decides (`rate_limit_exceeded` versus the quota and spend codes).
- **No code at all.** A `RUN_ERROR` with no usable code that is not `aborted` (Anthropic `"undefined"` without `errorType`, OpenAI connection errors, Gemini non-JSON messages) is a network failure: fail over.

---

## 6. What failover needs from the SDK

- **A classifier in the models module:** `failoverWorthy(provider, runError): "failover" | "never" | "credential"`. It reads `code`, `errorType`, `retryAfterMs`, and for Gemini the status parsed from `message`. It is tested against the table in §5. This is the deep module: three adapters' inconsistencies behind one function.
- **Run it inside the `model` activity, before recording.** `liveChunks` (loop.ts around line 470) would check the chunks for a `RUN_ERROR`, classify it, and on `failover` call the next Model's adapter. The recorded activity then holds the successful chunks plus which Model served them, so billing (`liveCall`'s meter) bills the Model that actually ran.
- **Keep `code` and `errorType` when a Step fails.** Today `loop.ts:977` keeps only the message, so the Turn's error can't say "rate limited" versus "bad key".
- **Optional upstream fixes to TanStack AI** (would remove the Gemini special case):
  - The Gemini adapter should set `code` from `ApiError.status` via `toRunErrorPayload`.
  - The Gemini adapter should map `SAFETY` and similar to `finishReason: 'content_filter'`.

---

## 7. Open points for the spec (not decided here)

- **Spend cap or credits exhausted.** "Bad credentials never fail over" covers 401. An exhausted user key is different: the next Model _on the same credential_ fails too, but a Model on the Host's credentials might not. Options: (A) treat it as never; (B) skip every Model on that credential and try the rest of the rule. B fits "Models the user can't reach are skipped".
- **A 404 retired Model in a rule.** The rule says never, but a stale Model rule would then fail every Turn of that Task kind. Failing over once and flagging the rule may be kinder.
- **Gemini `retryOptions`.** Should the Gemini adapter be given `httpOptions.retryOptions`, so it retries like the other two before failing over? That is a Host-side change in `apps/web/src/model-providers.ts`.
- **A Gemini safety block is invisible.** It looks like an empty answer, so a refused Gemini Step can't be told apart from "nothing to say" without the upstream fix.
