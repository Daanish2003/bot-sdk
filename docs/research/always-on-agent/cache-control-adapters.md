# Cache control and cache tokens through our adapters

Research for [#653](https://github.com/Daanish2003/ai-chat/issues/653) (child of map [#419](https://github.com/Daanish2003/ai-chat/issues/419)). Researched 2026-10-20. Facts only, no recommendation.

This builds on [#388's findings](https://github.com/Daanish2003/ai-chat/blob/research/prompt-caching-compaction/docs/research/always-on-agent/prompt-caching-compaction.md) (TTLs, prices, prefix rules, and the first pass over the adapters) and doesn't repeat them.

Versions read from the installed `node_modules/.pnpm` copies, pinned in [`packages/bot-sdk/package.json`](../../../packages/bot-sdk/package.json): `@tanstack/ai` 0.66.0, `@tanstack/ai-anthropic` 0.20.0 (`@anthropic-ai/sdk` 0.97.1), `@tanstack/ai-openai` 0.28.0 on `@tanstack/openai-base` 0.12.6 (`openai` 7.30.0), and `@tanstack/ai-gemini` 0.37.0 (`@google/genai` 2.27.0). Codex CLI source: `openai/codex` at `61469096`.

## Summary

- **The ChatGPT plan doesn't go through the Codex backend.** Our plan calls use the OpenAI adapter's default base URL, `https://api.openai.com/v1`, with the plan's OAuth token as the API key. OpenAI's Sign in with ChatGPT docs say to use that public endpoint and "do not point it at ChatGPT's `backend-api` endpoints". Those docs list `prompt_cache_retention` among the parameters to omit. They say nothing about `prompt_cache_key`, prompt caching or cached-token usage. Nobody has yet checked against the live route whether the plan reports `cached_tokens`.
- **Codex CLI** (which uses `chatgpt.com/backend-api/codex`) sends `prompt_cache_key` (by default the session id) and a `session-id` header. A code comment says ChatGPT "derives cache affinity from the Responses session-id header". It sends no retention option. It parses both `cached_tokens` and `cache_write_tokens`.
- **Anthropic: every breakpoint position the ticket names can be reached through the adapter.** Tools take one through `metadata.cacheControl`. Each system prompt takes its own through `systemPrompts: [{ content, metadata: { cache_control } }]`. Text, image and document parts take one through part `metadata.cache_control`. `ttl: "1h"` passes through every one of these unchanged. The adapter can't put a breakpoint on a `tool_use` block, on the `tool_result` block itself, or on text in an assistant message that has tool calls. Our code passes plain strings and no metadata today.
- **Anthropic limits:** 4 breakpoints per request, and the top-level automatic one takes one of the 4. 1-hour entries must come before 5-minute ones. The lookback checks at most 20 positions per breakpoint. The adapter reports cache writes as one total and drops the 5-minute and 1-hour split.
- **OpenAI: `prompt_cache_key` reaches the request.** `modelOptions` is spread into the Responses body unfiltered. But the package types `prompt_cache_retention` as `'in-memory' | '24h'`, and the API takes `in_memory`. GPT-5.6's `prompt_cache_options` isn't typed, but it reaches the request at runtime. A `prompt_cache_breakpoint` on a message can't: the adapter rebuilds every `input_text` block, and system prompts go to `instructions`, which can't carry one. `buildResponsesUsage` reads only `cached_tokens`. To get `cache_write_tokens` back, something has to read the raw stream, such as a `fetch` wrapper like our plan fetch.
- **Gemini:** implicit cache hits come back as `usageMetadata.cachedContentTokenCount`, which becomes `promptTokensDetails.cachedTokens`. The per-modality `cacheTokensDetails` goes to `providerUsageDetails`. `promptTokenCount` includes the cached tokens. Gemini has no cache-write count.

## 1. ChatGPT plan

### Where our plan calls go

- [`adapters.ts`](../../../packages/bot-sdk/plugins/models/server/adapters.ts) calls `createOpenaiChat(model, apiKey, { fetch: chatgptPlanFetch() })` on linked credentials, and sets no `baseURL`. The `openai` SDK defaults to `process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"` (`openai/client.js` line 95). So plan calls go to `POST https://api.openai.com/v1/responses`.
- The token comes from the Better Auth `chatgpt` provider. Its resource is `https://api.openai.com/v1` and its scopes include `chatgpt.tokens.use.direct` ([`packages/auth/src/index.ts`](../../../packages/auth/src/index.ts) lines 47, 131, 140). `@tanstack/ai-openai`'s own `siwc.ts` uses the same resource and scope.
- [`chatgpt-plan.ts`](../../../packages/bot-sdk/plugins/models/server/chatgpt-plan.ts) changes the body in only two ways: it sets `store: false`, and it sends effort `none` as `low`. It adds no headers and no cache fields. `response.completed` (and its `usage`) passes through untouched, apart from the `output` refill.
- The #639 probe ([#638 comment](https://github.com/Daanish2003/ai-chat/issues/638)) didn't record usage or cached tokens.

### What OpenAI documents for this route [S1, S2]

- **Endpoint:** "Use the public Responses API endpoint above for this ChatGPT plan usage flow; do not point it at ChatGPT's `backend-api` endpoints." `store: false` and `stream: true` are required.
- **Parameters to omit (preview limitations):** "`background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, and `user`." (The #639 probe saw `max_output_tokens: 4000` accepted.)
- `prompt_cache_key`, `prompt_cache_options`, prompt caching, cached tokens and session headers are **not mentioned**.
- The plan's Models (`gpt-6.1-sol`, `gpt-6-luna`) are later than GPT-5.6. On GPT-5.6 and later, OpenAI's prompt-caching guide says "OpenAI handles cache routing automatically; the key is not needed to optimize caching" [O1]. The guide doesn't mention the ChatGPT plan.

### What Codex CLI sends (`chatgpt.com/backend-api/codex`) [C1]

- `ResponsesApiRequest` (`codex-rs/codex-api/src/common.rs`) has `prompt_cache_key: Option<String>`, and no retention or `prompt_cache_options` field. It always sends `store: false` and `stream: true`.
- The key comes from a `PromptCacheKey` policy (`core/src/thread_manager.rs`): `SessionDerived` (the default), `Custom(key)`, or `Omit`. `SessionDerived` uses the session id, or `"{source}:{parent_thread_id}"` for internal sub-sessions (`core/src/client.rs` `session_derived_cache_key`).
- It also sends a `session-id` header (`codex-api/src/requests/headers.rs`). `client.rs` comments: "ChatGPT derives cache affinity from the Responses session-id header."
- Usage: `codex-api/src/sse/responses.rs` parses `input_tokens_details.cached_tokens` and `cache_write_tokens` (with `#[serde(default)]`), and it has a test that parses `cached_tokens: 40, cache_write_tokens: 60`.
- `client.rs` compares requests for a `prompt_cache_key_changed` cache-miss reason. The `openai` 7.30.0 types list the same reasons for `prompt_cache_diagnostics`: `model_changed`, `prompt_cache_key_changed`, `tools_changed`, `input_changed` and others.

### Not verified

Whether `api.openai.com/v1/responses` on a plan token returns `usage.input_tokens_details.cached_tokens` (and `cache_write_tokens`) and honours `prompt_cache_key`. That needs a live call on a linked plan, sending the same prefix twice. Neither the docs nor the probe say.

## 2. Anthropic through `@tanstack/ai-anthropic` [T1]

### Where a breakpoint can go

| Position                                | How                                                                                                                                                                                                                                                                                                                                                    | Source                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Whole request (automatic)               | `modelOptions.cache_control: { type: "ephemeral", ttl? }`. It's on the allow-list and copied as is.                                                                                                                                                                                                                                                    | `adapters/text.ts` lines 551–606                                  |
| A tool                                  | `metadata: { cacheControl: { type: "ephemeral", ttl: "5m" \| "1h" } }` on the tool. `@tanstack/ai`'s `toolDefinition` accepts `metadata`. `customTool(name, description, schema, cacheControl)` builds one. The adapter sends it as `cache_control`, or `null` when it's unset. Tools go out in the order they're given.                               | `tools/custom-tool.ts`, `tools/tool-converter.ts`                 |
| Each system prompt                      | `systemPrompts: [{ content, metadata: { cache_control } }, "plain string", …]`. Each entry becomes its own `system` text block, carrying its own `cache_control` when one is set.                                                                                                                                                                      | `adapters/text.ts` lines 631–646; `AnthropicSystemPromptMetadata` |
| A user message part                     | Array content: a `text` part's `metadata` is **spread whole** into the block (`cache_control`, `citations`). `image` and `document` parts copy `metadata.cache_control`. String content becomes a plain string with no breakpoint.                                                                                                                     | `adapters/text.ts` lines 718–797, 929–953                         |
| An assistant message without tool calls | Array content parts go through the same conversion, so a breakpoint is possible.                                                                                                                                                                                                                                                                       | lines 907–927                                                     |
| An assistant message with tool calls    | Text is taken only from string content (array parts are dropped). `tool_use` blocks are built with no `cache_control`. **No breakpoint possible.**                                                                                                                                                                                                     | lines 845–905                                                     |
| A tool result                           | The `tool_result` block is built with no `cache_control`. Array content parts inside it go through the part conversion, so a text part's `metadata.cache_control` lands on the nested block. Anthropic's docs list tool results as cacheable [A1], but this read didn't establish whether they honour a breakpoint on a block nested inside `content`. | lines 823–843                                                     |
| Thinking blocks                         | Never carry one. Anthropic: "Thinking blocks cannot be cached directly with `cache_control`" [A1].                                                                                                                                                                                                                                                     | —                                                                 |

- The adapter merges consecutive same-role messages, so a tool result and the next user message become one `user` message (`mergeConsecutiveSameRoleMessages`). Breakpoints on the parts survive the merge, since the blocks are concatenated.
- **TTL:** the system-prompt, text, image and document metadata are typed with the SDK's `CacheControlEphemeral` (`ttl?: '5m' | '1h'`). The tool type is `CacheControl` (`ttl: '5m' | '1h'`, **required**, `text/text-provider-options.ts` line 377). Every one is copied unchanged, so `ttl: "1h"` reaches the request. No beta is needed: `computeAnthropicBetas` adds none for caching, and Anthropic's docs need only `ttl` in `cache_control` [A1]. Requests go through `client.beta.messages.create`.
- **Our code** passes `systemPrompts` as `string[]` (Bot loop [`loop.ts`](../../../packages/bot-sdk/plugins/bot/server/loop.ts) line 90, Assistant [`run-plan.ts`](../../../packages/bot-sdk/plugins/assistant/server/chat/run-plan.ts) line 109). It sets no tool or part metadata and no `cache_control`.

### Limits [A1]

- "You can define up to 4 cache breakpoints." "When used together, the automatic cache breakpoint uses one of the 4 available breakpoint slots." "If 4 explicit block-level breakpoints already exist, the API returns a 400 error (no slots left for automatic caching)."
- **Mixing TTLs:** "Cache entries with longer TTL must appear before shorter TTLs (that is, a 1-hour cache entry must appear before any 5-minute cache entries)." Automatic caching takes a `ttl`. "If the last block has an explicit `cache_control` with a different TTL, the API returns a 400 error."
- **Lookback:** "The system checks at most 20 positions per breakpoint, counting the breakpoint itself as the first. If the system finds no matching entry in that window, checking stops (or resumes from the next explicit breakpoint, if any)." The same applies to automatic caching. "In a growing conversation the final block works as long as each turn adds fewer than 20 blocks." Otherwise "add a second breakpoint closer to that position from the start so a write accumulates there before you need it." (#388 notes that a run of consecutive `tool_use` or `tool_result` blocks counts as one.)
- Automatic caching on a last block that isn't eligible: "the system silently walks backward to find the nearest eligible block. If none is found, caching is skipped."

### Cache tokens

`buildAnthropicUsage` (`usage.ts`) maps `cache_read_input_tokens` to `promptTokensDetails.cachedTokens` and `cache_creation_input_tokens` to `cacheWriteTokens`, falling back to the `message_start` usage. It doesn't read `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, whose sum is `cache_creation_input_tokens` [A1]. So when 5-minute and 1-hour writes (1.25× and 2×) are mixed, the adapter can't tell them apart. [`run-usage.ts`](../../../packages/bot-sdk/plugins/models/server/run-usage.ts) adds reads and writes back into `input` for `anthropic`/`bedrock`. It keeps `cached` (reads) and doesn't store writes separately.

## 3. OpenAI through `@tanstack/ai-openai` [T2]

### Sending cache options

- `OpenAIResponsesTextAdapter.mapOptionsToRequest` (`adapters/text.ts` lines 116–196) validates only `metadata` and `conversation`/`previous_response_id`. The base (`openai-base/src/adapters/responses-text.ts` line 2218) puts `...modelOptions` first, then `model`, `metadata`, `instructions`, `input`, `tools` and the schema format. So any `modelOptions` key that isn't one of those reaches the body.
- **`prompt_cache_key`** is typed (`text/text-provider-options.ts` line 94) and sent as is.
- **`prompt_cache_retention`** is typed `'in-memory' | '24h'` (line 100). The `openai` 7.30.0 type is `'in_memory' | '24h' | null`, and the docs' values are "`in_memory`" and "`24h`" [O1]. Our installed SDK also marks it "@deprecated. Use `prompt_cache_options.ttl` instead", and notes "For `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported." So the typed `'in-memory'` isn't a value the API lists. `'24h'` matches.
- **`prompt_cache_options`** (`mode`, `ttl: '30m'`, `prewarm`, `comparison_response_id`, in `openai` 7.30.0) isn't in the TanStack types. Being an extra `modelOptions` key, it still reaches the body at runtime. Our `modelOptions` is typed `Record<string, unknown>`, so TypeScript doesn't stop it.
- **`prompt_cache_breakpoint`:** the API takes it on `input_text`, `input_image` and `input_file` blocks (`openai` 7.30.0 types), but not on top-level `instructions` [O1]. The adapter joins every system prompt into `instructions` (line 2225). `convertContentPartToInput` builds `input_text` as `{ type, text }`, dropping part metadata (line 2455). So no breakpoint reaches the request without a subclass overriding `convertContentPartToInput` / `convertMessagesToInput`, which are `protected` and documented as override points, or a `fetch` that rewrites the body.

### Cache tokens

- `buildResponsesUsage` (`openai-base/src/usage.ts`) reads `input_tokens_details.cached_tokens` into `cachedTokens` and doesn't read `cache_write_tokens`. It's a module function used by both `chatStream` and the non-stream path, so it isn't an override point. The Chat Completions builder reads `cache_write_tokens` only for Moonshot's shape.
- The API reports `usage.input_tokens_details.cache_write_tokens` (`openai` 7.30.0 `InputTokensDetails`, required `number`) [O1]. In the stream, `usage` arrives on `response.completed`, which the adapter reads at line 697.
- **The only place to recover it without patching the package** is the raw stream. A `fetch` passed as the adapter's `config.fetch` sees every `response.completed` event, as [`chatgpt-plan.ts`](../../../packages/bot-sdk/plugins/models/server/chatgpt-plan.ts) `fillCompletedOutput` already does for plan calls. `RUN_FINISHED` carries only the built `usage`, not the raw response.
- `promptTokens` is `input_tokens`, which includes cached tokens, so `run-usage.ts` doesn't add them back for `openai` (it's right not to).

## 4. Gemini through `@tanstack/ai-gemini` [T3]

- No configuration turns on implicit caching. The adapter joins all system prompts with `"\n"` into one `systemInstruction` (`adapters/text.ts` lines 1287–1291). Tools are converted on every call, and `modelOptions` is spread into `config`.
- `buildGeminiUsage` (`usage.ts`):
  - `usageMetadata.cachedContentTokenCount` (when it's above 0) becomes `promptTokensDetails.cachedTokens`
  - `usageMetadata.cacheTokensDetails` (per modality) becomes `providerUsageDetails.cacheTokensDetails`
  - `promptTokenCount` becomes `promptTokens`, and `thoughtsTokenCount` becomes `reasoningTokens`
- In the stream, usage goes on `RUN_FINISHED` from the chunk that ends the run, and only when that chunk has `usageMetadata` (lines 987–1000).
- `@google/genai` 2.27.0 documents `promptTokenCount` as "The total number of tokens in the prompt… When `cached_content` is set, this also includes the number of tokens in the cached content". `cachedContentTokenCount` is "The number of tokens in the cached content that was used for this request". So `promptTokens` already includes cached tokens, and `run-usage.ts` rightly doesn't add them for `gemini`.
- Google's caching page says only "You can see the number of tokens which were cache hits in the response object's `usage_metadata` field" for implicit caching, with "no cost saving guarantee" [G1]. It doesn't name the field, or say whether `promptTokenCount` includes the hits for implicit caching (the SDK wording above covers `cached_content`).
- **No cache-write field.** Gemini has no write charge for implicit caching, and the adapter emits no `cacheWriteTokens`.

## Not covered

- A live check that the plan route reports `cached_tokens` and honours `prompt_cache_key` (see §1).
- Whether the API rejects `prompt_cache_retention: "in-memory"` or ignores it. Not sent.
- Whether Anthropic honours `cache_control` on a block nested inside `tool_result.content` (the adapter's only way to mark a tool result).
- Bedrock, OpenRouter and the other adapters.

## Sources

- [S1] OpenAI, [Sign in with ChatGPT: Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [S2] OpenAI, [Sign in with ChatGPT: Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [O1] OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [A1] Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [G1] Google, [Context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [C1] `openai/codex` at `61469096fe086ccdbe87c06f9efc4ee59a4b51fe`: `codex-rs/core/src/client.rs`, `codex-rs/codex-api/src/common.rs`, `codex-rs/core/src/thread_manager.rs`, `codex-rs/codex-api/src/requests/headers.rs`, `codex-rs/codex-api/src/sse/responses.rs`
- [T1] `@tanstack/ai-anthropic` 0.20.0 `src/adapters/text.ts`, `src/text/text-provider-options.ts`, `src/message-types.ts`, `src/tools/custom-tool.ts`, `src/tools/tool-converter.ts`, `src/usage.ts`; `@anthropic-ai/sdk` 0.97.1 `resources/messages/messages.d.ts` (`CacheControlEphemeral`)
- [T2] `@tanstack/ai-openai` 0.28.0 `src/adapters/text.ts`, `src/text/text-provider-options.ts`, `src/siwc.ts`; `@tanstack/openai-base` 0.12.6 `src/adapters/responses-text.ts`, `src/usage.ts`; `openai` 7.30.0 `resources/responses/responses.d.ts`, `client.js`
- [T3] `@tanstack/ai-gemini` 0.37.0 `src/adapters/text.ts`, `src/usage.ts`; `@google/genai` 2.27.0 `dist/genai.d.ts`
- This repo: [`adapters.ts`](../../../packages/bot-sdk/plugins/models/server/adapters.ts), [`chatgpt-plan.ts`](../../../packages/bot-sdk/plugins/models/server/chatgpt-plan.ts), [`run-usage.ts`](../../../packages/bot-sdk/plugins/models/server/run-usage.ts), [`packages/auth/src/index.ts`](../../../packages/auth/src/index.ts)
