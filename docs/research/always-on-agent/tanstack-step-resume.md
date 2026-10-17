# How TanStack AI's loop can save and resume per Step

Research for [#480](https://github.com/Daanish2003/ai-chat/issues/480) (map [#413](https://github.com/Daanish2003/ai-chat/issues/413)). Builds on [How TanStack AI can run a SendToUser-only loop](https://github.com/Daanish2003/ai-chat/blob/research/tanstack-sendtouser-loop/docs/research/always-on-agent/tanstack-sendtouser-loop.md) ([#457](https://github.com/Daanish2003/ai-chat/issues/457)). Facts and links only, no design. Researched 2026-10-17.

**Versions read.** The installed sources in `node_modules/.pnpm`, at the versions `pnpm-lock.yaml` pins: `@tanstack/ai` 0.66.0, `@tanstack/ai-anthropic` 0.20.0, `@tanstack/ai-openai` 0.28.0 with `@tanstack/openai-base` 0.12.6, `@tanstack/ai-gemini` 0.37.0, `@tanstack/ai-ollama` 0.11.14 (the repo's patch, `patches/@tanstack__ai-ollama@0.11.14.patch`, changes only `dist/`), `@tanstack/ai-mistral` 0.6.15. Upstream links point at the release tags in [TanStack/ai](https://github.com/TanStack/ai): `@tanstack/ai@0.66.0` = `cc7c92a`, `@tanstack/ai-anthropic@0.20.0` = `ec85900`, `@tanstack/ai-openai@0.28.0` = `410d8eb`, `@tanstack/ai-gemini@0.37.0` = `86ea934`, `@tanstack/ai-ollama@0.11.14` = `7f1e6b6`, `@tanstack/ai-persistence@0.8.1` = `25f8522`. Line numbers come from the installed copy.

Shorthand: **[CHAT]** = [`packages/ai/src/activities/chat/index.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/index.ts), **[MW]** = [`packages/ai/src/activities/chat/middleware/types.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/middleware/types.ts), **[COMPOSE]** = [`.../middleware/compose.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/middleware/compose.ts), **[TOOLS]** = [`.../chat/tools/tool-calls.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/tools/tool-calls.ts), **[ANT]** = [`packages/ai-anthropic/src/adapters/text.ts`](https://github.com/TanStack/ai/blob/ec85900b2fd399ef981030246c3dc286b128ccc1/packages/ai-anthropic/src/adapters/text.ts), **[OAI]** = [`packages/openai-base/src/adapters/responses-text.ts`](https://github.com/TanStack/ai/blob/410d8eb2198c71b57e83e768bdbd72b46ec35778/packages/openai-base/src/adapters/responses-text.ts).

## Headline facts

1. **`onShouldContinue` is the one hook that runs once per Step after the tool results are in the transcript.** It is awaited, gets `state.messages` with the assistant tool-call message and its `role: 'tool'` results, and runs for a text-only Step too. `onToolPhaseComplete` runs earlier, before the results are appended to `ctx.messages` (they are only in its `info.results`).
2. **A text-only Step's assistant message is not in the transcript at `onShouldContinue`.** It is appended only in the terminal hook, just before `onFinish`.
3. **`chat()` restarted on a saved transcript runs any tool call that has no `role: 'tool'` result before the first model call.** A saved transcript whose SendToUser calls all have results is not re-run; one with an unanswered call is. `onBeforeToolCall` can return `{ type: 'skip', result }` to give a result without running the tool.
4. **Tool-call ids are the provider's when it gives one** (Anthropic `tool_use.id`, OpenAI Responses `call_id`); Gemini and Ollama fall back to a `name_Date.now()` id when the provider omits one. The id is stored on the transcript and replayed as-is.
5. **An aborted model call leaves nothing in `ctx.messages`** (no partial assistant message, no partial tool calls), keeps the partial text in `ctx.accumulatedContent`, and reports no usage on Anthropic or OpenAI, which send usage only on the final stream event.

---

## 1. A hook after each Step, and whether the tool results are in

### How one Step runs

- The loop is `do { … } while (await shouldContinue())` ([CHAT] L1326–1382). Each Step is two half-cycles: `processText` (one model call, `streamModelResponse`) and `executeToolCalls` (`processToolCalls`). `endCycle()` flips between them and increments `iterationCount` after the tool half ([CHAT] L1523–1531).
- `shouldContinue()` returns `true` right after the model half without calling anything ("Always enter the tool-execution half-cycle after a model turn"). After the tool half it builds `AgentLoopState` from `this.messages` and runs `agentLoopStrategy` and every middleware's `onShouldContinue` ([CHAT] L3712–3737). So **`onShouldContinue` fires exactly once per Step, after the tool phase**, including for a text-only Step (whose tool half just sets `toolPhase = 'stop'`, [CHAT] L2314–2320).
- `runOnShouldContinue` awaits each middleware in order ([COMPOSE] L842 onward), so an async write in the hook finishes before the next model call starts.

### When each piece enters the transcript

| What                                                          | Appended to `this.messages` / `ctx.messages`                                                    | Source                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Assistant message with `toolCalls` (and any text before them) | In `processToolCalls`, before the tools run (`addAssistantToolCallMessage`)                     | [CHAT] L2335, L2692–2716                               |
| Each tool's `role: 'tool'` result                             | After **all** tools of the Step ran and after `onToolPhaseComplete`, in `buildToolResultChunks` | [CHAT] L2460–2468, L2475, L3448–3595 (append at L3590) |
| A text-only Step's assistant message                          | Only in `runTerminalHook` → `addTerminalAssistantMessages()`, right before `onFinish`           | [CHAT] L1218, L1249, L2718 onward                      |

- So at **`onShouldContinue`** the transcript holds the Step's tool calls and their results. For a text-only Step it does **not** yet hold the Step's text; that is in `ctx.accumulatedContent` until `onFinish`.
- At **`onToolPhaseComplete`** ([MW] L806–809) the results are in `info.results` (`toolCallId`, `toolName`, `result`), not yet in `ctx.messages`.
- **`onAfterToolCall`** ([MW] L797–800) fires per tool as it completes, with `toolCallId` and `result`. With `toolExecution: 'sequential'` that is after each SendToUser, while the Step's results are not yet in `ctx.messages`.
- `ctx.messages` is reassigned to a new array each time (`this.middlewareCtx.messages = this.messages`, e.g. [CHAT] L2715, L3592, L4913), so it must be read at the time of the hook, not captured once.
- `onIteration` ([MW] L745–748, called at [CHAT] L1552) fires at the start of each Step, before the model call.
- `onUsage` fires once per model call whose `RUN_FINISHED` carries usage ([MW] L815–818; [CHAT] L1761–1763).
- In the stream the caller reads, a tool Step's `RUN_FINISHED` is held back and yielded after the tools ran, before the `TOOL_CALL_RESULT` chunks ([CHAT] L1743–1750 defer, L2518 flush, L2520–2524 results).

### TanStack's own persistence does not save per Step

- `@tanstack/ai-persistence` 0.8.1 (not a dependency of this repo) `withPersistence` saves the thread in `onStart`, on an interrupt `RUN_FINISHED` in `onChunk`, and in `onFinish`; with `snapshotStreaming` it also saves a throttled partial assistant message (default every 1000 ms) ([`packages/ai-persistence/src/middleware.ts` L2050–2051, L2251–2263, L2266–2376, L2384–2408](https://github.com/TanStack/ai/blob/25f8522b7941b9e48b4158364e9abaa0ee97c0a0/packages/ai-persistence/src/middleware.ts#L2251-L2408)). It has no `onShouldContinue` or `onToolPhaseComplete` save.

## 2. Starting `chat()` again from a saved transcript

- `chat({ messages })` takes `UIMessage | ModelMessage` and converts them with `convertMessagesToModelMessages` ([CHAT] L1019); `ModelMessage`s pass through `convertOwnMessages` with `createdAt` restored ([`messages.ts` L188 onward](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/messages.ts#L188)).
- Every model call sends the whole current list: `adapter.chatStream({ messages: this.providerMessages, … })` ([CHAT] L1615–1617), and `providerMessages` is reset from the config before each call ([CHAT] L4896–4902). The built-in loop holds no provider-side state between Steps, so a new `chat()` given the same messages sends the same history to the next model call.
- `ctx.messageCount` is the length of the input `messages` ([CHAT] L1005, L1105). `turn.ts` slices `engine.messages.slice(engine.messageCount)` for the Turn's transcript, so on a restarted `chat()` that slice would only hold messages added by the new call.
- `iterationCount`, `toolCallCount` and `lastTurnToolCallCount` are fields of the engine and start at 0 for each `chat()` call ([CHAT] L3716–3722, L3739–3750). A Step limit counted with `state.iterationCount` restarts on a new call.
- `threadId` defaults to a new id per call unless passed (`threadId` / `conversationId`, [CHAT] L1043–1046); `runId` can be passed too ([CHAT] L1047).
- Before the loop, `chat()` runs `checkForPendingToolCalls()` ([CHAT] L1305, L2134 onward); see section 3.

## 3. Keeping a Step whose tools already ran from running again

### What `chat()` re-runs on start

- `getPendingToolCallsFromMessages()` ([CHAT] L3598–3648) collects every `role: 'tool'` message's `toolCallId` (except ones whose content parses to `{ pendingExecution: true }`, or that are in the resume-denied set), then returns every assistant `toolCalls` entry whose `id` is not in that set. Provider-executed calls (e.g. Anthropic `web_search`) are skipped.
- `checkForPendingToolCalls()` executes those pending calls through the same `executeToolCalls` path, with `onBeforeToolCall` / `onAfterToolCall` / `onToolPhaseComplete`, appends their results, and then the loop's first model call follows ([CHAT] L2134–2312).
- So a resumed transcript where every SendToUser call has a matching `role: 'tool'` message runs no tool on start. A transcript with a SendToUser call and no result **runs it again**. `turn.ts`'s `answeredCalls()` already drops unanswered calls before saving (`packages/bot-sdk/plugins/bot/server/turn.ts`, `answeredCalls`).
- Results are appended for the whole Step at once, after all of its tools ran ([CHAT] L2460–2524). A crash between two SendToUser calls of one Step leaves neither result in `ctx.messages`; per-call results are visible only through `onAfterToolCall`.

### The skip decision

- `onBeforeToolCall` may return `{ type: 'skip', result }`: the tool does not run, `result` is recorded as its result with `duration: 0`, and `onAfterToolCall` still fires with `ok: true` ([MW] L416–429; [TOOLS] L630–668). The first middleware returning a non-null decision wins ([COMPOSE] L493–520).
- `toolCacheMiddleware` uses this to return a cached result keyed by `JSON.stringify([toolName, args])` by default, in memory (LRU, 100) or a custom `storage` ([`tool-cache-middleware.ts` L60–120](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/middleware/tool-cache-middleware.ts#L60-L120)). The key is name and args, not the tool-call id.

### The tool-call id

- The engine takes each call's `id` from the adapter's `TOOL_CALL_START.toolCallId` ([`tool-calls.ts` L267–285](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/tools/tool-calls.ts#L267-L285)) and stores it on the assistant message's `toolCalls` and on the result's `toolCallId`.
- **Anthropic:** `id: event.content_block.id` from the `tool_use` block ([ANT] L1128–1137); replayed as `tool_use.id` and `tool_result.tool_use_id` ([ANT] L830, L879–892). The adapter de-duplicates `tool_result` blocks with the same `tool_use_id`, keeping the first ([ANT] L1042–1053).
- **OpenAI (Responses):** "TanStack AI uses `call_id` as the canonical tool-call ID" ([OAI] L185–195); `callId: item.call_id || item.id` ([OAI] L1597, L1765, L1934); replayed as `call_id` ([OAI] L2294, L2395).
- **Gemini:** `functionCall.id || \`${functionCall.name}_${Date.now()}_${nextToolIndex}\`` ([`packages/ai-gemini/src/adapters/text.ts` L807–809](https://github.com/TanStack/ai/blob/86ea934ccdc8367da6ff269610f43ce618f11171/packages/ai-gemini/src/adapters/text.ts#L807-L809)).
- **Ollama:** `actualToolCall.id || \`${actualToolCall.function.name}_${Date.now()}\`` ([`packages/ai-ollama/src/adapters/text.ts` L250–251](https://github.com/TanStack/ai/blob/7f1e6b674c86a117372bab69b6489dafc8927f2d/packages/ai-ollama/src/adapters/text.ts#L250-L251)).
- **Mistral:** `id: toolCallDelta.id || ''` (installed `@tanstack/ai-mistral` 0.6.15, `src/adapters/text.ts` L459).
- Once saved, the id is whatever was stored: nothing in `@tanstack/ai` re-derives it. An id is created per model response, so a repeated model call gets new ids (for the timestamp fallbacks this is visible in the code; for provider ids, see Unverified).

## 4. Stepping by hand (one `chat()` per Step) versus hooking the built-in loop

Facts about what each costs, from the code; no recommendation.

- **Provider calls and tokens:** the same in both. Each model call sends the full message list either way ([CHAT] L1615–1617), and the built-in loop starts no extra call.
- **One Step per `chat()`:** `agentLoopStrategy: maxIterations(1)` stops after the first Step's tool half, since `iterationCount` is 1 by then and `maxIterations` is `iterationCount < max` ([`agent-loop-strategies.ts` L26–27](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/agent-loop-strategies.ts#L26-L27); [CHAT] L1523–1531). The default without a strategy is `maxIterations(5)` ([CHAT] L1003–1004).
- **Per-call work in-process**, repeated for each `chat()`: building the engine, converting all input messages ([CHAT] L1019), the lazy-tool scan of history ([CHAT] L1022–1027), prepending `devtoolsMiddleware()` ([CHAT] L1054–1056), middleware `setup` / `onConfig` (init) / `onStart` ([CHAT] L1270–1290), the pending-tool scan ([CHAT] L1305), and a terminal hook (`onFinish` / `onAbort` / `onError`) ([CHAT] L1218–1260, L1482–1492).
- **Per-call stream shape:** each call yields its own `RUN_STARTED` / `RUN_FINISHED` and gets a new `requestId` ([CHAT] L1034); counters restart (section 2).
- **Text-only Step with one call per Step:** the Step's text is in `ctx.messages` at that call's `onFinish` (section 1).
- **Hooking the built-in loop:** one engine, one `onStart` / terminal hook per Turn; `onShouldContinue` gets the cumulative `iterationCount` / `toolCallCount` and the transcript with tool results; the hook is awaited. A crash still ends that engine, so a resume is a new `chat()` from the saved transcript either way (section 2).

## 5. What an aborted model call leaves behind

- `chat({ abortController })` passes `abortController.signal` to the adapter as `request.signal` ([CHAT] L1036–1039) and combines it with the middleware abort signal for tools (`toolAbortSignal`, [CHAT] L1057–1062). Anthropic hands it to the SDK call as `signal` ([ANT] L384–393).
- In `streamModelResponse`, each chunk first checks `isCancelled()` and `break`s ([CHAT] L1632–1635), so a chunk arriving after the abort (including an adapter `RUN_ERROR`) is not processed. The loop then returns at the next `if (this.isCancelled()) return` ([CHAT] L1328), and `finally` calls `onAbort` with `reason` and `cancelRequested` ([CHAT] L1482–1492).
- **Partial text:** each `TEXT_MESSAGE_CONTENT` delta processed before the abort is added to `accumulatedContent` and mirrored to `ctx.accumulatedContent` ([CHAT] L1869–1880). It is not appended to `ctx.messages`: the terminal-assistant append runs only in `runTerminalHook`, which the abort path does not call ([CHAT] L1218, L1249, L1328).
- **Partial tool calls:** held in the engine's `ToolCallManager` and appended to `ctx.messages` only in `processToolCalls` ([CHAT] L2335), which an abort during the model call does not reach. An abort **during the tool phase** leaves the assistant tool-call message in `ctx.messages` without results, since results are appended only after all tools finish (section 3).
- **Usage:** Anthropic sends usage only on `message_delta` with a `stop_reason`, combining it with `message_start` usage ([ANT] L1127, L1561–1563); OpenAI Responses attaches `chunk.response.usage` to the terminal `RUN_FINISHED` ([OAI] L2066–2078). An aborted call emits neither, so `onUsage` is not called for it and no `RUN_FINISHED` with usage reaches the stream. On an SDK error (not a cancelled chunk), both adapters yield a `RUN_ERROR` without usage ([ANT] L401–420, L1655–1670).
- `AbortInfo` carries only `reason`, `duration` and `cancelRequested` ([MW] L534–555); `FinishInfo.usage` exists only on `onFinish` ([MW] L520–529).

## Unverified

- No `chat()` was run. The order of hooks and the abort behaviour are read from the 0.66.0 source, not observed.
- Whether providers bill an aborted request's input tokens (and whether an SDK abort surfaces as a `RUN_ERROR` the engine processes, as `turn.ts`'s comment says "the adapter often reports the cancelled request as one") was not tested. The code path above drops chunks after `isCancelled()`, but a `RUN_ERROR` produced before the signal is seen as aborted would be processed.
- That Anthropic `tool_use.id` and OpenAI `call_id` are unique per response and never repeat on a re-sent request was not checked against provider docs.
- Whether the Anthropic and OpenAI APIs accept a replayed transcript whose last message is a `role: 'tool'` result from an earlier request, with no change, was not tested (the built-in loop does the same between Steps).
- Mistral's empty-string fallback id (`''`) and what the engine does with several calls sharing it was not traced.
- `@tanstack/ai-persistence` and `@tanstack/ai-durable-stream` were read only as far as the save points above; their run-resume features (`RunStore`, attach/takeover) were not traced.
- Adapters other than Anthropic, OpenAI, Gemini, Ollama and Mistral (Bedrock, Groq, Grok, OpenRouter, Cloudflare, BytePlus, LLM Gateway) were not checked for tool-call ids or abort usage.
