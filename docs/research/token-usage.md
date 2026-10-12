# Token usage and context limits in TanStack AI

Research for issue #43 (child of the map #38). Researched on 2026-10-08 against the installed packages in `packages/api/package.json`: `@tanstack/ai` 0.64.1 and the 14 Provider adapters (anthropic 0.19.4, openai 0.26.0, gemini 0.34.2, openrouter 0.20.3, mistral 0.6.13, groq 0.8.2, grok 0.20.4, bedrock 0.4.2, cloudflare 0.2.2, byteplus 0.5.2, llmgateway 0.2.2, lovable 0.4.0, vercel-gateway 0.3.3, ollama 0.11.12), plus their transitive base `@tanstack/openai-base` 0.12.3.

How to read the sources:

- **Sources.** Everything below comes from reading those packages' published `src/` and checking the claims against it. Paths are relative to `node_modules/@tanstack/<package>/src/`, and `OB/` means `@tanstack/openai-base/src/`.
- **External sources.** `models.dev` and OpenRouter were queried live on 2026-10-08. `@tanstack/ai-compaction` 0.1.13 was read from its npm tarball.
- **Unverified.** Nothing here was run against a live Provider. Claims about what a Provider actually sends on the wire are marked **unverified**.

---

## Recommendation

1. **Record usage per run by summing every `RUN_FINISHED`, and treat it as best-effort.**
   - **Where usage arrives.** Every adapter puts a `TokenUsage` on `RUN_FINISHED`. A run that calls a tool (for example web search) has one model iteration per call, and each iteration emits its own `RUN_FINISHED`.
   - **How to sum.** Add them up with `addTokenUsage` (exported from `@tanstack/ai`). In `run.ts` you can do that while scanning the chunks, or in an `onUsage` middleware.
   - **Don't use `onFinish`.** Its `usage` holds only the last iteration.
   - **When usage is missing.** It is absent whenever a run errors, is stopped, or (on several adapters) hits the output cap. So a quota that needs a number must fall back to an estimate for those runs: characters ÷ 4 for the prompt plus the streamed text.
2. **Normalise usage before you price or count it.**
   - **Cache tokens.** Anthropic and Bedrock report `promptTokens` _without_ cache reads and writes. The OpenAI-shaped adapters (Responses and Chat Completions) and Gemini report it _with_ cached tokens.
   - **Reasoning tokens.** These sit inside `completionTokens` everywhere they are reported. Gemini may be the exception (see §1).
   - **Cost.** No adapter except OpenRouter fills `cost`. Compute cost yourself from a price table.
3. **Keep context window, max output and price on the curated Model list, seeded from models.dev.**
   - **Why not the adapters.** Their `model-meta.ts` objects are module-private, and five adapters ship no limits at all.
   - **Curated Models.** A snapshot script that reads `https://models.dev/api.json` covers most of our curated Models. For OpenRouter's live list, use the fields its models API already returns (`context_length`, `top_provider.max_completion_tokens`, `pricing`).
   - **Ollama.** It needs a per-host lookup (**unverified**, see §2).
4. **Keep long Conversations in the window with `@tanstack/ai-compaction`'s `withCompaction` middleware.**
   - **What it does.** It rewrites only the messages sent to the Provider. Our Message tree stays the source of truth, so ADR 0001 is untouched.
   - **Setup.** Start with `evictOldest`, with `maxTokens` ≈ context window − max output − a margin.
   - **Estimator.** Replace the default estimator, which counts base64 attachments as text.
   - **Dependency.** Added as `@tanstack/ai-compaction` 0.1.14 on `@tanstack/ai` 0.66.0 (#115). Its path to eviction ids is in §3, "Tracer result".
5. **Generation settings need an SDK-owned mapping per Provider.**
   - **No common keys.** `chat()` 0.64.1 has no common `temperature`, `topP` or `maxTokens`. Every setting goes through `modelOptions`, spelled the Provider's way, and several adapters restrict them per Model.
   - **What to build.** A small `GenerationSettings` type (`temperature`, `maxOutputTokens`, `topP`, `reasoningEffort`), translated per Provider with the table in §4.
   - **Hide what a Model doesn't accept.** Hide a setting the Model rejects, using models.dev `temperature: false` / `reasoning_options`, or OpenRouter `supported_parameters`. Don't send it.

Today `run.ts` reads none of this: it passes no `modelOptions` and ignores usage (`packages/api/src/chat/run.ts:91-104`). Storing usage per Message is a **schema change, and so a human decision**.

---

## Per-adapter table

**Column key:**

- **API**:
  - **R** = OpenAI-style Responses (`OB/adapters/responses-text.ts`).
  - **CC** = Chat Completions (`OB/adapters/chat-completions-text.ts`).
  - **own** = the adapter's own implementation.
- **Cache r/w**: whether cached-read and cache-write tokens are filled.
- **Reason.**: whether `completionTokensDetails.reasoningTokens` is filled.
- **Prompt incl. cache?**: whether `promptTokens` already contains cached tokens.
- **At output cap**: what the run emits when it hits the max-tokens limit.
- **Abort fwd**: whether the abort signal reaches the Provider request.

| Provider (factory)                         | API              | Cache r/w     | Reason.                    | Cost                            | Prompt incl. cache? | At output cap                                 | Abort fwd  | Max-tokens key                                                       | Sampling keys                                                | Reasoning key                              | Limits/price in model-meta               |
| ------------------------------------------ | ---------------- | ------------- | -------------------------- | ------------------------------- | ------------------- | --------------------------------------------- | ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------- |
| anthropic (`createAnthropicChat`)          | own              | r + w         | no (inside output)         | no                              | **no**              | `RUN_ERROR max_tokens`, **no usage**          | yes        | `max_tokens` (defaults to the Model's max output, or 64k if unknown) | `temperature`, `top_p` (not both), `top_k`, `stop_sequences` | `thinking`, `output_config.effort`         | context, max out, price (no cache-write) |
| openai (`createOpenaiChat`)                | R                | r             | yes                        | no                              | yes                 | `RUN_ERROR`, **no usage**                     | yes        | `max_output_tokens`                                                  | `temperature`, `top_p` (stripped for o*/gpt-5*)              | `reasoning.effort`                         | context, max out, price                  |
| gemini (`createGeminiChat`)                | own              | r             | yes (`thoughtsTokenCount`) | no                              | yes                 | `RUN_ERROR` **and** `RUN_FINISHED` with usage | yes        | `maxOutputTokens`                                                    | `temperature`, `topP`, `topK`, `stopSequences`               | `thinkingConfig`                           | max input, max out, price                |
| openrouter (`createOpenRouterText`)        | own (SDK)        | r + w         | yes                        | **yes** (`cost`, `costDetails`) | yes                 | `finishReason: length` + usage                | yes        | `maxCompletionTokens`                                                | `temperature`, `topP`, `stop` (+ `topK` etc. untyped)        | `reasoning.effort`                         | context, max out, price (private)        |
| mistral (`createMistralText`)              | own (fetch)      | no            | no                         | no                              | n/a                 | `length` + usage (if on finish chunk)         | **no**     | `max_tokens`                                                         | `temperature`, `top_p`, `stop` (allow-list)                  | none                                       | context, max out, price                  |
| groq (`createGroqText`)                    | CC               | r + w         | yes                        | no                              | yes                 | `length` + usage                              | yes        | `max_completion_tokens`                                              | `temperature`, `top_p`, `stop`                               | `reasoning_effort`, `reasoning_format`     | context, max out, price                  |
| grok (`createGrokText`)                    | R                | r             | yes                        | no                              | yes                 | `RUN_ERROR`, **no usage**                     | yes        | `max_output_tokens`                                                  | `temperature`, `top_p`                                       | `reasoning.effort` (throws on grok-build)  | context, price (max out on 4.7 only)     |
| bedrock (`createBedrockText`, Converse)    | own              | r + w         | no                         | no                              | **no**              | `length` + usage                              | **no**     | `max_completion_tokens`                                              | `temperature`, `top_p`, `stop`                               | **none**                                   | **none**                                 |
| cloudflare (`createCloudflareText`)        | CC               | r + w if sent | yes if sent                | no                              | yes                 | `length` + usage                              | yes (REST) | `max_tokens`                                                         | `temperature`, `top_p`, `top_k`                              | `reasoning_effort`, `chat_template_kwargs` | **none**                                 |
| byteplus (`createBytePlusText`)            | CC               | r + w if sent | yes if sent                | no                              | yes                 | `length` + usage                              | yes        | `max_tokens` **or** `max_completion_tokens` (not both)               | `temperature`, `top_p`, `top_k`, `stop`                      | `thinking`, `reasoning_effort`             | context, max in/out (no price)           |
| llmgateway (`createLLMGatewayText`)        | CC               | r + w if sent | yes if sent                | no (dropped)                    | yes                 | `length` + usage                              | yes        | `max_tokens`                                                         | `temperature`, `top_p`, `stop`                               | `reasoning_effort`                         | context, max out, price (no cache-write) |
| lovable (`createLovableText`)              | **R** by default | r             | yes                        | no                              | yes                 | `RUN_ERROR`, **no usage**                     | yes        | `max_output_tokens` (R)                                              | `temperature`, `top_p`                                       | `reasoning` (shape **unverified**)         | **none**                                 |
| vercel-gateway (`createVercelGatewayText`) | **R** by default | r             | yes                        | no (dropped)                    | yes                 | `RUN_ERROR`, **no usage**                     | yes        | `max_output_tokens` (R)                                              | `temperature` (per-Model `Pick`)                             | `reasoning` (shape **unverified**)         | **none**                                 |
| ollama (`createOllamaChat`)                | own              | no            | no                         | no                              | n/a                 | `finishReason: stop` (cap not detected)       | **no**     | `options.num_predict`                                                | `options.temperature`, `top_p`, `top_k`, `stop`, `num_ctx`   | `think`                                    | `context` only, some Models              |

**On every adapter:**

- **Abort or error.** An abort or a thrown error ends in `RUN_ERROR` with no usage.
- **No usage reported.** If the Provider sends no usage, the `usage` key is left off. It is never zero-filled.
- **No terminal event.** A stream that ends without one behaves as follows:
  - **Synthetic success.** CC adapters and Bedrock still emit `RUN_FINISHED` with `finishReason: 'stop'` and no usage, so a cut-off stream looks like success.
  - **Error.** R adapters emit `RUN_ERROR incomplete-stream`.
  - **Nothing.** Anthropic, Gemini and Ollama emit no terminal event at all.

---

## 1. Usage reporting per run

### The type

`TokenUsage` is defined in `@tanstack/ai-event-client` (`src/index.ts:265`) and re-exported from `@tanstack/ai` (`types.ts:1292-1301`). Its fields:

- `promptTokens`, `completionTokens`, `totalTokens`. `totalTokens` "may exceed prompt + completion when reasoning/cache/tool tokens are billed separately".
- `promptTokensDetails`: `cachedTokens`, `cacheWriteTokens`, `audioTokens`, `imageTokens`, `textTokens`, `videoTokens`, `documentTokens`.
- `completionTokensDetails`: `reasoningTokens` plus the same modality counts.
- `providerUsageDetails` (opaque), `cost`, and `costDetails` (`upstreamCost`, `upstreamInputCost`, `upstreamOutputCost`).

On the wire (AG-UI) it travels as `usage[]` with `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteInputTokens` and `reasoningTokens`. The rest travels in a TanStack leftover. `rebuildTokenUsage` / `toSpecTokenUsage` convert between the two (`ai/src/utilities/ag-ui-usage.ts`).

### Where to read it in `chat()`

- **Stream.** The chat engine emits one `RUN_FINISHED` per model iteration. If tools are about to run, it defers that event until after them (`ai/src/activities/chat/index.ts:1344-1363`, `2513-2528`). Each event carries that iteration's usage.
- **`onUsage(ctx, usage)` middleware hook.** It is called "once per model iteration that reports usage" (`activities/chat/middleware/types.ts:799-806`, fired from `index.ts:1749-1751`).
- **`onFinish` hook.** Its `usage` is rebuilt from `this.finishedEvent`, which is reset at the start of every iteration (`index.ts:1532`, `1954`, `1238-1245`). So it is **the last iteration only, not the run total**.
- **Run total.** Use `addTokenUsage(a, b)` (`ag-ui-usage.ts:124-178`). It adds the numbers, keeps `providerUsageDetails` from the last iteration, and is what `@tanstack/ai-persistence` uses to sum.

### Per-adapter detail

**Anthropic** (`ai-anthropic/src/usage.ts:28-81`)

- **Fields.**
  - `promptTokens` = `input_tokens`, which is uncached input only.
  - `totalTokens` is _computed_ as input + output, leaving cache tokens out.
  - `cachedTokens` / `cacheWriteTokens` come from `cache_read_input_tokens` / `cache_creation_input_tokens`, and are set only when non-zero.
  - Web search and web fetch counts go to `providerUsageDetails.serverToolUse`.
  - There are no reasoning tokens: thinking is counted inside `output_tokens`.
- **Streaming.**
  - Usage is read only from the `message_delta` that carries `stop_reason` (`adapters/text.ts:1531-1619`). `message_start` is never read.
  - **`stop_reason: max_tokens` yields `RUN_ERROR` code `max_tokens` with no usage** (`text.ts:1565-1595`). The tokens were still billed.

**OpenAI, Grok, Lovable and Vercel Gateway (Responses)** (`OB/usage.ts:98-129`)

- **Fields.**
  - `input_tokens` → `promptTokens` (includes cached).
  - `output_tokens` → `completionTokens` (includes reasoning).
  - The Provider's `total_tokens` is used as-is.
  - `cachedTokens` and `reasoningTokens` are filled. There is no cache-write.
- **When usage arrives.** Only on `response.completed` (`OB/adapters/responses-text.ts:2052-2067`).
- **Truncated and failed runs lose usage.** `response.incomplete` (including hitting `max_output_tokens`) and `response.failed` become `RUN_ERROR` and throw away `response.usage` (`responses-text.ts:1345-1399`, verified). That makes the `'length'` branch effectively unreachable for truncation.
- **Default API.** Lovable and Vercel Gateway default to Responses. `{ api: 'chat' }` switches them to Chat Completions (`ai-lovable/src/adapters/factory.ts:20-46`, `ai-vercel-gateway/src/adapters/factory.ts:29-47`).

**Groq, Cloudflare, BytePlus and LLM Gateway (Chat Completions)** (`OB/usage.ts:15-86`)

- **Request.** The base always sends `stream_options: { include_usage: true }` (`OB/adapters/chat-completions-text.ts:114-121`).
- **Capture.** It takes usage from any chunk (the last one wins). `RUN_FINISHED` waits until the iterator is drained, so the trailing usage-only chunk is counted.
- **Fields.**
  - Prompt, completion and total tokens.
  - `cachedTokens` (from `prompt_tokens_details.cached_tokens` or a root `cached_tokens`).
  - `cacheWriteTokens`, `reasoningTokens`, and audio tokens.
  - Prediction tokens go to `providerUsageDetails`.
- **Cost.** **Any `usage.cost` a gateway sends is dropped.**
- **Groq.** It moves `x_groq.usage` onto `chunk.usage` (`ai-groq/src/adapters/text.ts:135-150`).
- **Cloudflare.** It patches Workers AI's trailing `{response, usage}` chunk so the base can read it (`ai-cloudflare/src/utils/fetch.ts:4-50`).
- **Unverified.** Which detail fields BytePlus, Workers AI and LLM Gateway actually send.

**OpenRouter** (`ai-openrouter/src/usage.ts:21-63`, `adapters/cost.ts:86-101`)

- **The most complete adapter.**
  - Base counts.
  - Every prompt detail (cached, cache write, audio, video).
  - Reasoning and audio completion details.
  - **`cost`**, plus `costDetails.upstreamCost/upstreamInputCost/upstreamOutputCost` from `upstream_inference_*`.
- **Request.** Usage is requested with `streamOptions.includeUsage: true` (`adapters/text.ts:182-185`).
- **Not mapped.** `serverToolUseDetails` and `isByok`.

**Gemini** (`ai-gemini/src/usage.ts:121-207`)

- **Fields.**
  - `promptTokenCount` → `promptTokens`.
  - `candidatesTokenCount` → `completionTokens`.
  - `totalTokenCount` → `totalTokens`, falling back to the sum.
  - `cachedContentTokenCount` → `cachedTokens`.
  - `thoughtsTokenCount` → `reasoningTokens`.
  - Per-modality counts.
- **Usage chunk.** Usage is read only from the chunk that carries `finishReason` (`adapters/text.ts:903-993`).
- **Output cap.** `MAX_TOKENS` emits `RUN_ERROR` _and then_ `RUN_FINISHED` with usage (`text.ts:935-992`).
- **Unverified.** Google documents `candidatesTokenCount` as excluding thought tokens. If so, `completionTokens` under-counts billed output for thinking Models; add `reasoningTokens` when pricing.

**Bedrock (Converse)** (`ai-bedrock/src/converse/usage.ts:14-32`)

- **Fields.** `inputTokens` is uncached only. `cacheReadInputTokens` / `cacheWriteInputTokens` are kept even when 0, and the Provider's `totalTokens` is used as-is (whether it includes cache is **unverified**). There are no reasoning tokens.
- **When usage arrives.** It comes on the trailing `metadata` event, and `RUN_FINISHED` waits for it (`converse/stream-processor.ts:256-303`).
- **Abort.** **The abort signal is not passed to `ConverseStreamCommand`** (`adapters/converse-text.ts:210-220`).

**Mistral** (`ai-mistral/src/adapters/text.ts`)

- **Fields.** Prompt, completion and total tokens only (`:581-595`).
- **Request.** It sends `include_usage: true`.
- **Usage-only chunks are skipped.** The loop does `if (!choice) continue` (`:341-342`, verified), so a trailing usage-only chunk is dropped. Usage counts only if Mistral puts it on the `finish_reason` chunk (**unverified**).
- **Abort.** `fetch` is called without the abort signal (`:746-750`, verified).

**Ollama** (`ai-ollama/src/usage.ts:28-69`)

- **Fields.** `prompt_eval_count` / `eval_count`, with total computed. The timings go to `providerUsageDetails`.
- **When usage arrives.** On the final `done: true` chunk.
- **Output cap.** `done_reason` is never read, so hitting `num_predict` reports `stop`.
- **Abort.** The abort signal is never forwarded. `run.ts` already works around that with `untilAborted`.

### Reliability summary

**What makes usage missing:**

- **Errors and aborts.** Usage is lost on every `RUN_ERROR`: abort, network or Provider error.
- **Truncation.** It is also lost when the output cap is hit, on Anthropic and on the four Responses-based adapters.
- **For the record.** A stopped run (our `stopped` status) and a `max_tokens` error _were billed_, so usage-based quotas undercount unless you estimate those runs.

**What makes it inconsistent:**

- **Prompt totals.** `promptTokens` means "uncached input" on Anthropic and Bedrock, and "all input" elsewhere.
- **Totals.** `totalTokens` is computed on Anthropic and Ollama, and reported by the Provider elsewhere.
- **Cost.** Only OpenRouter fills `cost`.

---

## 2. Context window and price per Model

### Adapter `model-meta.ts`

Not usable as our source:

- **Private.** The per-Model objects are module-private in every adapter. Only id arrays and types are exported, e.g. `ai-anthropic/src/index.ts:44-48`.
- **Inconsistent field names.** Most use `context_window` + `max_output_tokens`/`max_completion_tokens`, but Gemini uses `max_input_tokens` and Ollama uses `context`.
- **Prices.** `pricing: { input: { normal, cached? }, output: { normal } }` in USD per million tokens, where present.
- **Missing entirely.** No limits at all in Bedrock, Cloudflare, Lovable or Vercel Gateway. No price in BytePlus or Ollama.
- **Gaps in the prices.** No cache-write price, and no long-context price tier. OpenRouter's generated `cached` price for `anthropic/claude-sonnet-4.5` (4.05) is above its normal price (3), so it is suspect.

### models.dev

Source: `https://models.dev/api.json`, queried 2026-10-08.

- **Size.** 226 Providers.
- **Fields per Model.**
  - `limit: { context, input?, output }`
  - `cost: { input, output, cache_read, cache_write }`, USD per million tokens. Optional `tiers[]` and `context_over_200k` hold long-context prices; e.g. `openai/gpt-5.6` has a 272k tier.
  - `reasoning`, `reasoning_options`, `temperature` (whether the Model accepts it), `tool_call`, `attachment`, and `modalities`.
- **Coverage of our curated list**, matching our model ids:

  | Provider                                                                                                                                                             | Coverage                                                                                                                                                  |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | anthropic, openai, gemini (`google`), mistral, grok (`xai`), bedrock (`amazon-bedrock`), cloudflare (`cloudflare-workers-ai`), llmgateway, vercel-gateway (`vercel`) | every curated Model                                                                                                                                       |
  | groq                                                                                                                                                                 | 2 of 5 (Kimi K2 0905, Qwen3 32B and Llama 4 Maverick are missing)                                                                                         |
  | byteplus                                                                                                                                                             | no `byteplus` key. Its Models appear under `volcengine` with a `doubao-` prefix (`doubao-seed-2-0-lite-260428`, `glm-5-2-260617`), so they need an id map |
  | lovable                                                                                                                                                              | absent. Its ids are `google/...` and `openai/...`, so they can be looked up under those Providers (the price may differ, **unverified**)                  |
  | ollama                                                                                                                                                               | absent (local Models). `ollama-cloud` exists                                                                                                              |

- **Recommendation.** Use a script that snapshots models.dev into the curated list (or a JSON file next to it). Don't fetch at runtime: models.dev is a community dataset, and a snapshot keeps prices reviewable in a diff.

### OpenRouter models API

Source: `https://openrouter.ai/api/v1/models`, queried 2026-10-08, 467 Models.

- **Fields per Model.** `context_length`, `top_provider.{context_length, max_completion_tokens}`, and `pricing` in USD **per token** as strings: `prompt`, `completion`, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `web_search`, plus `overrides[]` for long-context tiers.
- **Settings support.** `supported_parameters` (e.g. `temperature`, `top_p`, `max_tokens`, `reasoning`) and `reasoning.{supported_efforts, default_effort}`.
- **Already fetched.** `live-models.ts` already fetches this list and parses only `id`, `name`, `architecture` and `supported_parameters`. Adding `context_length`, `top_provider` and `pricing` to its zod schema is all the OpenRouter side needs.
- **Cost.** OpenRouter also reports the real `cost` per run (§1), so OpenRouter runs don't need a price table.

### Ollama

The context length depends on the host's Model and its `num_ctx`. Ollama's `/api/show` returns `model_info.<arch>.context_length` (**unverified**; not read in the adapter). Ollama has no price.

---

## 3. Keeping long Conversations in the window

**Strategies:**

| Strategy                  | What it does                                                | Cost                                   |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| Truncate / sliding window | Drop the oldest messages                                    | None                                   |
| Summarise                 | Replace old turns with an LLM summary                       | One extra call, and the summary drifts |
| Clear tool results        | Stub out old tool outputs (e.g. web-search results)         | Cheap, and works well for agent loops  |
| Provider-side             | Anthropic `context_management`, OpenAI `truncation: 'auto'` | Not portable                           |

On the Provider-side options:

- **Anthropic `context_management`.** It is in the adapter's `modelOptions` allow-list (`ai-anthropic/src/adapters/text.ts:544-558`).
- **OpenAI `truncation: 'auto'`.** It is in the OpenAI `modelOptions`.

**What TanStack AI offers:**

- **`@tanstack/ai` 0.64.1 itself.** It has no compaction. It does have `summarize()` (`activities/summarize/`).
- **`@tanstack/ai-compaction` 0.1.13.** This is the answer (`npm view`; README and `src/index.ts` read from the tarball). It is a `chat()` middleware: `withCompaction({ maxTokens, strategy, estimateTokens, strategyKey, onCompact })`.
  - **How it runs.** Before every model call (`onConfig`, skipping the `init` phase), it rewrites only the messages sent to the Provider. The canonical transcript and system prompts are unchanged.
  - **Built-in strategies.**
    - `evictOldest({ keepRecentTokens = maxTokens/2, marker })` (the default).
    - `summarizeOldest({ summarize, keepRecentTokens, summaryRole })`.
    - `clearToolResults({ keepRecentToolResults = 3, stub })`.
    - `composeStrategies(...)`, which escalates through strategies until the messages fit.
  - **Estimator.** The default is `chars / 4` over `JSON.stringify(content)` (`src/index.ts:228-233`). **For us that counts base64 image and PDF data as text** and would over-trigger on attachments. Pass an `estimateTokens` that counts an attachment as a fixed amount.
  - **Checkpoints.** With `withPersistence` providing metadata, it saves a checkpoint and reuses the compacted prefix. Without it, it is stateless (fine for us, since we rebuild messages from our tree per run).
  - **Events.** It emits `compaction:started|state|ended` CUSTOM events.
  - **Peer dependency.** `@tanstack/ai-compaction` 0.1.14 peers on `@tanstack/ai` **^0.66.0**, which the SDK now runs (0.66.0). Added to the Chat SDK under #115 (pre-approved in #51).
- **Using real usage instead of the estimate.** The previous run's `promptTokens` (plus cached tokens on Anthropic and Bedrock) is the Provider-accurate size of the history up to that point. An `estimateTokens` could calibrate against it, or the UI could show "x% of context used". This is a design idea, not a TanStack feature.

**Suggested shape:**

- **Formula.** `withCompaction({ maxTokens: contextWindow − maxOutput − margin, strategy: composeStrategies(clearToolResults(), evictOldest()) })`. `contextWindow` and `maxOutput` come from the Model data in §2.
- **Later.** Add `summarizeOldest` once quotas exist to pay for the extra call.

### Tracer result: which Messages were evicted (#115)

**Verdict: use the middleware (`evictOldest`), not the SDK's own pre-`chat()` fallback.** The middleware runs before every model call, so a tool iteration inside one Run evicts again. The fallback runs once and would let a tool-heavy Run grow past the budget. The cost is that the middleware reports counts, not ids, so the SDK derives the context start itself.

Tested in `packages/chat-sdk/test/core/server/chat/compaction-tracer.test.ts` (5 tests, against `chat()` with the fake adapter, `@tanstack/ai-compaction` 0.1.14, `@tanstack/ai` 0.66.0):

- **Eviction.** With six stored Messages and `maxTokens: 40`, the Model is sent the marker and the newest Messages. The oldest are missing.
- **Context start.** `onCompact` reports `{ before, after, messagesBefore, messagesAfter }` and no ids. `evictOldest` prepends one marker, so the first Message the Model saw is at index `messagesBefore - (messagesAfter - 1)` of the sent list. Map that index back to a stored Message through the per-Message list the SDK built (one Message can yield several ModelMessages, for example web search tool calls).
- **Tool iterations.** Each model call is compacted again from the canonical list. In the test, the second call had 8 messages and the cut was at index 6, past the six stored Messages. So the first Message the Model saw can be the Run's own assistant tool-call Message, which has no stored history yet.
- **Custom estimator.** `estimateTokens` is accepted and changes the eviction. In the test a 1,000-token image fixed amount kept 2 sent Messages where the default kept 5.

**Limits found:**

- **`compaction:state` has no ids.** `dropped` and `result` are role, token and text previews, with text cut at 4,000 characters and at most 24 entries. `dropped` is computed by JSON equality, so an identical earlier Message is wrongly left out of `dropped` (the test shows this). Do not map evictions from `compaction:*` events.
- **The start index is only valid for `evictOldest`.** It assumes exactly one marker is prepended. Other strategies (`clearToolResults` keeps the count, `summarizeOldest` adds one message) need their own derivation.
- **The marker is sent to the Model.** It reads `[N earlier message(s) omitted to save context.]`, where N counts ModelMessages, not stored Messages. Pass a `marker` option, or accept the wording.
- **One oversized Message is kept, not refused.** By reading `src/index.ts` (`splitAtRecent`), when the newest Message alone exceeds `keepRecentTokens`, it still keeps that Message. The Provider then gets it and fails. The pre-Run refusal the spec asks for has to be a separate check (not tested here).
- **No checkpoints here.** Checkpoints need `withPersistence` metadata, which the SDK does not use, so the middleware is stateless.

---

## 4. Generation settings per adapter

- **No common keys.** `chat()` in 0.64.1 has **no common `temperature` / `topP` / `maxTokens`** (`ai/src/types.ts:1080-1131`). All sampling goes through `modelOptions` in the Provider's own spelling.
- **The core's key list.** The core keeps one for itself (`utilities/sampling-keys.ts`, and `MAX_TOKENS_KEY_BY_ADAPTER` in `activities/summarize/chat-stream-summarize.ts:90-102`).
- **Core gaps and a bug.**
  - The core's map has no entry for mistral, bedrock, byteplus, lovable or vercel-gateway.
  - It spells Grok's cap `max_tokens`, while the Grok adapter (Responses) reads `max_output_tokens`. That looks like a core bug, and it only affects `summarize()`.

| Adapter            | Temperature                                                      | Top-p                     | Max output                                            | Reasoning effort                                                                                       | Also                                                                                        | Enforced restrictions / defaults                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------- | ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| anthropic          | `temperature`                                                    | `top_p`                   | `max_tokens`                                          | `thinking: {type:'enabled', budget_tokens} \| {type:'adaptive'}`, `output_config.effort` (`low`…`max`) | `top_k`, `stop_sequences`. Unknown keys are dropped with a logged error (`text.ts:544-584`) | Default `max_tokens` = the Model's max output (64k if unknown). Throws if `temperature` and `top_p` are both set, or `budget_tokens` < 1024 or ≥ `max_tokens` (`text-provider-options.ts:369-415`). The "no sampling" rule for newer Models is type-level only |
| openai             | `temperature`                                                    | `top_p`                   | `max_output_tokens`                                   | `reasoning: {effort: none…high, summary}`                                                              | `verbosity`, `truncation`, `prompt_cache_key`                                               | **Silently strips** `temperature` / `top_p` for `o*` and `gpt-5*` Models (`ai-openai/src/adapters/text.ts:155-173`)                                                                                                                                            |
| gemini             | `temperature`                                                    | `topP`                    | `maxOutputTokens`                                     | `thinkingConfig: {thinkingBudget, thinkingLevel, includeThoughts}`                                     | `topK`, `stopSequences`, `seed`                                                             | None. The API rejects what it doesn't support                                                                                                                                                                                                                  |
| openrouter         | `temperature`                                                    | `topP`                    | `maxCompletionTokens`                                 | `reasoning: {effort: none…max}`                                                                        | `stop`, `seed`, `provider`, `models` fallbacks; `topK` / `minP` untyped                     | Per-Model type narrowing from `supports`                                                                                                                                                                                                                       |
| mistral            | `temperature`                                                    | `top_p`                   | `max_tokens`                                          | none (Magistral thinks without a setting)                                                              | `stop`, `random_seed`                                                                       | Allow-list: other keys are dropped                                                                                                                                                                                                                             |
| groq               | `temperature`                                                    | `top_p`                   | `max_completion_tokens`                               | `reasoning_effort` (`none`/`default` for Qwen3; `low`/`medium`/`high` for gpt-oss), `reasoning_format` | `stop`, `seed`                                                                              | Reasoning text only streams with `reasoning_format: 'parsed'`                                                                                                                                                                                                  |
| grok               | `temperature`                                                    | `top_p`                   | `max_output_tokens`                                   | `reasoning: {effort: none…high}`                                                                       | none                                                                                        | Defaults `store: false`. **Throws** if `reasoning` is set on `grok-build-0.1` (`ai-grok/src/adapters/text.ts:116-120`)                                                                                                                                         |
| bedrock (Converse) | `temperature`                                                    | `top_p`                   | `max_completion_tokens` → `inferenceConfig.maxTokens` | **none** (no `additionalModelRequestFields`, so Claude thinking can't be enabled)                      | `stop`                                                                                      | None                                                                                                                                                                                                                                                           |
| cloudflare         | `temperature`                                                    | `top_p`                   | `max_tokens`                                          | `reasoning_effort` (`low`/`medium`/`high`/`null`), `chat_template_kwargs.enable_thinking`              | `top_k`, `seed`                                                                             | None                                                                                                                                                                                                                                                           |
| byteplus           | `temperature`                                                    | `top_p`                   | `max_tokens` or `max_completion_tokens` (both = 400)  | `thinking: {type}`, `reasoning_effort` (`none`…`max`, per-Model)                                       | `top_k`, `stop`                                                                             | `reasoning_effort` together with `thinking: disabled` = 400 (per TSDoc)                                                                                                                                                                                        |
| llmgateway         | `temperature`                                                    | `top_p`                   | `max_tokens`                                          | `reasoning_effort`                                                                                     | `stop`, `seed`                                                                              | Gateway strips unsupported params (per TSDoc)                                                                                                                                                                                                                  |
| lovable            | `temperature`                                                    | `top_p`                   | `max_output_tokens` (Responses default)               | `reasoning` (shape **unverified**)                                                                     | `stop` (type-checks, but not a Responses param)                                             | Responses options type isn't wired, so chat-only keys type-check                                                                                                                                                                                               |
| vercel-gateway     | `temperature` (per-Model `Pick`, e.g. absent for `openai/gpt-5`) | not in any curated `Pick` | `max_output_tokens` / `max_tokens`                    | `reasoning` (shape **unverified**)                                                                     | `gateway: {order, only, sort, caching, byok, …}`                                            | Per-Model `Pick` types                                                                                                                                                                                                                                         |
| ollama             | `options.temperature`                                            | `options.top_p`           | `options.num_predict`                                 | `think: boolean \| 'low'\|'medium'\|'high'`                                                            | `options.top_k`, `options.num_ctx`, `options.stop`                                          | None                                                                                                                                                                                                                                                           |

**Which settings a Model takes:**

- **models.dev.** `temperature: false` and `reasoning_options` say whether the Model accepts temperature and which reasoning efforts it supports.
- **OpenRouter.** `supported_parameters` and `reasoning.supported_efforts` say the same.
- Examples: Claude Sonnet 5.5 in models.dev, and Claude Haiku 5.5 on OpenRouter, both refuse temperature.
- **Use.** The UI should hide settings from these flags.

---

## Side findings (out of scope, worth a ticket)

- **Bedrock and Mistral** don't forward the abort signal, so a stopped run keeps generating, and billing, upstream. Ollama has the same problem; `untilAborted` only stops reading the stream.
- **Mistral** joins `systemPrompts` with `.join('\n')`, so an object-form system prompt would be sent as `[object Object]` (`ai-mistral/src/adapters/text.ts:922-926`). We pass strings today, so we're unaffected.
- **openai-base Responses** forwards the top-level `chat({ metadata })` onto the wire as Responses `metadata` (`OB/adapters/responses-text.ts:2207`). That contradicts the core docstring (`ai/src/types.ts:1121-1129`).
