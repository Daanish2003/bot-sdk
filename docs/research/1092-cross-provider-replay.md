# Replaying a Turn's history on another Provider mid-Turn

Research for issue #1092 (child of the map #1091, "Model routing"). Researched on 2026-10-31 against the installed TanStack AI 1.0.0 packages: `@tanstack/ai` 1.0.0, `ai-anthropic` 1.0.0, `ai-openai` 1.0.0 (with `@tanstack/openai-base`), `ai-gemini` 1.0.0, `ai-openrouter` 1.0.0, `ai-ollama` 1.0.0. The Bot SDK depends directly on `ai-anthropic` and `ai-openai` (`packages/botsdk/bot/package.json`). `apps/web` also installs Gemini, Ollama and OpenRouter.

How to read the sources:

- **Package sources.** Paths are relative to `node_modules/@tanstack/<package>/src/`.
- **Repo sources.** Paths are relative to the repo root.
- **Provider docs.** Anthropic: platform.claude.com `build-with-claude/thinking`. OpenAI: developers.openai.com `api/docs/guides/reasoning`. Gemini: ai.google.dev `generate-content/thought-signatures` and `generate-content/gemini-3` (through context7). All fetched 2026-10-31.
- **Unverified.** Nothing here was run against a live Provider. Every claim comes from reading source or docs.

---

## Answer

1. **Yes, a Turn's history can replay on another Provider, and TanStack AI 1.0 already does the conversion.** Each assistant message carries `metadata.tanstack.source = { provider, api, model }`. Every text adapter we use (except Ollama) runs `transformMessagesForReplay(messages, target, toolIdRule)` on each request. It rewrites only the request, never the stored history. A message whose source differs from the target in provider, API **or model** is "foreign".
2. **What replays cleanly:** user messages, text, tool calls (name and arguments), tool results, and images and PDFs in user content and in tool results, on targets that accept them.
3. **What is stripped or converted for a foreign message:**
   - **Signed reasoning is dropped.** Anthropic signatures, Anthropic `redacted_thinking`, OpenAI encrypted reasoning items and Gemini `thoughtSignature` are all removed.
   - **Visible thinking text is inlined into the assistant's text content.** The next Model sees the earlier Model's reasoning as if it had said it. This happens only when the Provider returned thinking text. Newer Claude models default to `display: "omitted"`, which returns none.
   - **Tool-call IDs are rewritten** to the target's allowed shape, with paired results remapped.
   - **Failed or aborted assistant messages are dropped,** along with their tool results. Unanswered calls get a synthetic `"No result provided"` result.
4. **One gap breaks a Gemini 3 target mid-Turn.** Gemini 3 returns a 400 for any `functionCall` in the current turn without a `thought_signature`. The adapter strips foreign signatures and doesn't send Google's documented dummy value. So failing over to Gemini 3 after another Model has called a tool in the same Turn fails. Anthropic and OpenAI targets accept foreign tool calls.
5. **Even a same-Provider switch (Opus to Sonnet) counts as foreign,** so it drops signatures. That's stricter than Anthropic's own advice, which is to keep passing them back. The cost is lost reasoning continuity, not an error.
6. **Our Checkpoints allow a Step to resume on a different Model, but the loop pins one Model per Turn today.** A failed model-call activity records nothing (ADR 0011), and a recorded one replays its chunks, which carry the real adapter's `source`. So a Step that fell back to Model B replays as B's output, with no Model called, and later Steps treat A's messages as foreign. What stops it today is `runLoop`: the Model, adapter, meter, Provider-keyed cache control, image check and context window are fixed once from `owner.model`.

## Recommendation for the failover design

- **Fail over inside the `model` activity.** Try the rule's Models in order inside one `ctx.step("model", …)`. Record the chunks of the Model that answered, plus its Model id, in `RecordedModelCall`. Replay stays deterministic because the fallback choice lives inside the recorded result. A failed attempt already records nothing.
- **Make the per-call pieces of `runLoop` per Model:** the adapter (`liveCall`), the request's `model`, `withCacheControl(provider, …)`, the billing meter (the `bill` activity must bill the Model that answered), `seesImages` and the Summary's `contextWindow`.
- **Stay on the fallback Model for the rest of the Turn.** Read the current Model from the last recorded Step, not from live health. Switching back would cost another cold cache and another foreign conversion.
- **Expect a cold cache on every cross-Provider failover.** The Stable prefix is cached per Provider, and an Anthropic target also loses the dropped thinking blocks' prefix. This fits the map's "no per-Step switching" stance: failover is the one accepted exception.
- **Exclude or patch targets that can't take a foreign Turn mid-way:**
  - **Gemini 3** needs the dummy `thoughtSignature` (`"context_engineering_is_the_way_to_go"`) on foreign current-turn calls. Either add it in our own pre-adapter step or skip Gemini 3 as a mid-Turn fallback when the Turn already has tool calls.
  - **Ollama** drops all thinking and `document` parts. It sends tool-result images as JSON text and URL images as-is, so it's a lossy target.
- **Capabilities filter first (already decided on the map).** A fallback must also pass the capability filter for what the Turn already holds. A Turn with screenshots in it can't fall back to a Model without image input: the OpenAI adapters replace the images with "(image omitted…)". A Computer-use Helper can only fall back to direct Anthropic or OpenAI Responses (ADR 0028).

---

## Evidence

### The core replay transform

`ai/src/utilities/replay-messages.ts`, `transformMessagesForReplay`:

- **`isForeign`** (lines 39–51): a message is foreign when it has a `source` and the target is given, and `provider`, `api` or `model` differs. A message with no `source` is never foreign.
- **Foreign assistant messages** (lines 174–231):
  - `thinking` and `blockOrder` are removed.
  - Each non-redacted, non-empty thinking block's `content` is added to the text content, in block order.
  - Tool calls go through `mapCall`, which applies the adapter's `toolIdRule` and strips `thoughtSignature` from the call's `metadata` (lines 107–138). Other metadata, such as `providerExecuted`, is kept.
- **Failed calls** (`isFailed`, lines 64–69): a message with `stopReason` `error` or `aborted` is skipped, along with the tool results of its calls (lines 151–157).
- **`closePending`** (lines 91–106): every call left without a result gets a `tool` message `"No result provided"`, except provider-executed calls.
- **Cut input** (lines 239–251): a call cut by `finishReason: 'length'` gets `{}` as its arguments.
- Its docstring: "Build a provider request without changing stored history" (line 71).

The engine calls it with no target, which only cleans (`ai/src/activities/chat/index.ts:2038–2043`): "The adapter knows its wire API, so it does the source-sensitive part of replay."

The source is stamped per model call from the adapter's chunks (`withCallMetadata`, `chat/index.ts:2354–2398`). The Anthropic adapter, for one, emits `metadata: { tanstack: { source } }` (`ai-anthropic/src/adapters/text.ts:1676–1680, 1744`).

### Per adapter

| Target                  | Calls the transform with a target                                         | Tool-ID rule                                                       | Notes                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic               | yes (`ai-anthropic/src/adapters/text.ts:914–925`)                         | `[a-zA-Z0-9_-]`, 64 chars                                          | Unsigned thinking is skipped unless `allowEmptySignature` (lines 1496–1517). Server tools (`web_search`) replay from the `anthropic` metadata key (lines 1543–1557).                      |
| OpenAI Responses        | yes (`openai-base/src/adapters/responses-text.ts:2800–2877`)              | `call                                                              | fc_…`composite; a cross-Provider item id is hashed to`fc_<hash>`                                                                                                                          | Reasoning items are kept only for same-source messages. `metadata.tanstack.reasoningItem` exists because "the API refuses a `msg_`/`fc_` item without the reasoning item that made it" (`ai/src/types.ts:719–725`). |
| OpenAI Chat Completions | yes (`openai-base/src/adapters/chat-completions-text.ts:1482–1504`)       | sanitized, hashed on collision                                     | A tool message is text only. Images move to a user message after the results, or become "(image omitted: this model has no image input)" (lines 1616–1636).                               |
| Gemini                  | yes (`ai-gemini/src/adapters/text.ts:80–102`)                             | only when the target needs IDs: Gemini 3+, `claude-*`, `gpt-oss-*` | `thoughtSignature` is set only when present (lines 1335–1349). There is no dummy signature (no `context_engineering` or `skip_thought` anywhere in the package).                          |
| OpenRouter              | yes (`ai-openrouter/src/adapters/text.ts:1392`, `responses-text.ts:1996`) | per adapter                                                        | Not read in depth.                                                                                                                                                                        |
| Ollama                  | **no**                                                                    | none                                                               | `formatMessages` (`ai-ollama/src/adapters/text.ts:532–594`) never sends `thinking`, drops `document` parts, `JSON.stringify`s array tool results, and pushes `image` source values as-is. |

### What each Provider requires

- **Anthropic.**
  - "When you return tool results, you must pass the thinking blocks from the assistant message back to the API, complete and unmodified."
  - "If you toggle thinking mid-turn … the API doesn't error. Instead, it silently disables thinking for that request." A foreign mid-Turn history that arrives with `tool_use` and no thinking blocks degrades, but doesn't fail.
  - "Switching models mid-conversation. Keep passing thinking blocks back unchanged when you switch models … the API ignores or drops the blocks the target model can't read."
  - "`signature` values are compatible across platforms, including the Claude API, Amazon Bedrock, and Claude Models on Google Cloud", except Sonnet 5.5 and Haiku 5.5 blocks, which are account-bound.
  - "Starting with Claude Fable 5.1, the API checks the `signature` … A block stays valid only while the top-level `system` prompt, the `tools`, and the messages before it are unchanged."

  TanStack drops signatures on any model change, so the same-Provider readability Anthropic describes is lost. That's safe but lossy.

- **OpenAI.**
  - "Persisted reasoning can be reused only within the same model family … When you switch families, the API omits incompatible reasoning."
  - Pass back "all reasoning items, function call items, and function call output items, since the last `user` message."

  Dropping foreign reasoning matches this.

- **Gemini 3.**
  - "Strict validation is enforced for all function calls within the current turn … If you omit a `thought_signature` for the first `functionCall` part in any step of the current turn, the request will fail with a 400 error."
  - The current turn is everything since the last user message with standard content, not a `functionResponse`.
  - For "transferring a conversation trace from another model … or injecting a custom function call", set `"thoughtSignature": "context_engineering_is_the_way_to_go"`.

  Earlier Turns are not validated. So cross-Turn switches to Gemini 3 work, and mid-Turn failover after a tool call does not.

### Our loop and Checkpoints

- **One activity per model call, replayed from its recorded result** (`docs/adr/0011-background-jobs-through-durable-runner.md`): "A thrown activity records nothing … retrying the job amounts to retrying the failed activity", and "Replay returns the recorded model output instead of calling the model again".
- **`durableAdapter`** (`packages/botsdk/bot/src/bot/agent-loop/loop.ts:503–562`):
  - It wraps the real adapter in `ctx.step("model", …)`.
  - It records the chunks with only `rawEvent` removed (`withoutRaw`, lines 1071–1076), so `metadata.tanstack.source` survives replay.
  - A `ModelCallError` ends the loop `error` (line 551). Today no failover happens, and the Turn ends.
- **Single-Model pins in `runLoop`:**
  - `provider` (line 303)
  - `liveCall` resolves `owner.model` once (lines 372–394)
  - `durableAdapter.name`/`model` (lines 508–509)
  - `withCacheControl(provider, cacheKey, …)` (line 489, `models/cache-control.ts:17`)
  - `seesImages` (line 346)
  - `contextWindow` (line 566)
  - the meter in `liveCall`, which bills the `bill` activity (lines 540–546)
- **History across Turns** is each earlier Turn's stored `input` and its `transcript`, kept as verbatim `ModelMessage[]` jsonb (`storage/bot/bot-turn.ts:75`, `bot/context/context.ts:405–413`). So `source`, `thinking` and signatures persist. Cross-Turn Model changes (a Task kind change) get the same foreign conversion.
- **`answeredCalls`** (`loop.ts:1114–1130`) already removes calls without results from the saved transcript, so a cut-off Step doesn't leave a dangling `tool_use`.

## Open points

- **Not run live.** A probe Turn that calls a tool on Claude, fails over to GPT and then to Gemini 3 would confirm points 4 and 5 of the answer. It's worth adding as an eval in the spec.
- **Foreign provider-executed tool calls.** An Anthropic `web_search` call replayed to OpenAI or Gemini isn't covered. Gemini skips provider-executed calls (`text.ts:1321`). The Bot uses Tavily as a client tool (`bot/agent-loop/tavily.ts`), so this doesn't arise today.
- **Reasoning text exposed to the next Model.** Inlining a foreign Model's reasoning as assistant text could change its behaviour or leak reasoning into later Turns. Whether to strip it rather than inline it is a design choice for the spec. It would need our own pre-adapter step, since TanStack has no option for it.
