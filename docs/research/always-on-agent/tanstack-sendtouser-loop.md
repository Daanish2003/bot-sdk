# How TanStack AI can run a SendToUser-only loop

Research for [#457](https://github.com/Daanish2003/ai-chat/issues/457) (map [#412](https://github.com/Daanish2003/ai-chat/issues/412)). Facts and links only, no recommendations. Researched 2026-10-17.

**Versions read.** The installed sources in `node_modules/.pnpm`, which match `packages/bot-sdk/package.json`: `@tanstack/ai` 0.66.0, `@tanstack/ai-anthropic` 0.20.0, `@tanstack/ai-openai` 0.28.0 (which depends on `@tanstack/openai-base` 0.12.6). Upstream links point at the release tags in [TanStack/ai](https://github.com/TanStack/ai): `@tanstack/ai@0.66.0` = [`cc7c92a`](https://github.com/TanStack/ai/tree/cc7c92a2569ec4ea28373734c89ab095b9b88d6a), `@tanstack/ai-anthropic@0.20.0` = [`ec85900`](https://github.com/TanStack/ai/tree/ec85900b2fd399ef981030246c3dc286b128ccc1), `@tanstack/ai-openai@0.28.0` = [`410d8eb`](https://github.com/TanStack/ai/tree/410d8eb2198c71b57e83e768bdbd72b46ec35778). Line numbers come from the installed copy.

Shorthand: **[CHAT]** = [`packages/ai/src/activities/chat/index.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/index.ts), **[TYPES]** = [`packages/ai/src/types.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/types.ts), **[MW]** = [`packages/ai/src/activities/chat/middleware/types.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/middleware/types.ts).

## Headline facts

1. **`chat()` has no provider-neutral `toolChoice`.** No `toolChoice` or `tool_choice` field exists anywhere in `@tanstack/ai/src`. Forcing a tool is done per adapter through `modelOptions.tool_choice`, which the Anthropic and OpenAI adapters both pass to the provider.
2. **Anthropic forced tool use is rejected by the newest Claude models.** Anthropic's docs say `tool_choice` `any` and `tool` return a 400 on Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1, and fail with manual extended thinking. Where forcing is accepted, the API prefills the turn, so the model writes no text before the `tool_use` block and skips thinking.
3. **The loop can stop right after a tool runs, with no further model call.** After a model turn with tool calls, the engine always runs the tool phase and only then asks `agentLoopStrategy` and every middleware's `onShouldContinue` whether to go on. Returning `false` there ends the run after the SendToUser tool has executed and its result has been streamed. There is no built-in "stop after tool X" option (such as a `returnDirect` or terminal flag on a tool); the check has to read the state.
4. **Plain text and tool calls come back separately.** On the stream, text arrives as `TEXT_MESSAGE_*` events and tool calls as `TOOL_CALL_*` events. In the message history, an assistant `ModelMessage` keeps text in `content` and calls in `toolCalls`. The repo's assistant today appends every `TEXT_MESSAGE_CONTENT` delta to `runText`.
5. **The open-source agents keep plain text private by policy, not by stopping the loop.** Letta Code's `MessageChannel` description tells the model to make the send its final action and then "finish with only `Sent.`", so a model turn still follows the send. OpenClaw's `message_tool_only` mode suppresses automatic delivery of the final text; whether its loop stops after a `send` is unverified. Classic Letta (MemGPT) did stop the loop at the tool: `send_message` got a `TerminalToolRule` by default.

---

## 1. Forcing tool use per adapter

### The core `chat()` options

- `TextOptions` ([TYPES] L1114 onward) has `model`, `messages`, `tools`, `context`, `systemPrompts`, `agentLoopStrategy`, `toolExecution`, `lazyToolsConfig`, `metadata`, `modelOptions`, `request` and `outputSchema`. It has no tool-choice field. A search of `@tanstack/ai/src` for `toolChoice|tool_choice` finds nothing.
- `modelOptions` is the provider-specific escape hatch: `modelOptions?: TProviderOptionsForModel` ([TYPES] L1165).
- **It can change per model call.** Middleware `onConfig` runs before every model call with `phase = 'beforeModel'` ([CHAT] L1337–1343). The config it receives and can return includes `modelOptions` and `tools` (`ChatMiddlewareConfig`, [MW] L333–349; built at [CHAT] L4422–4440). `applyMiddlewareConfig` writes the returned `modelOptions` back ([CHAT] L4896 onward). So `tool_choice` can be set for one iteration and changed for the next.

### Anthropic (`@tanstack/ai-anthropic` 0.20.0)

- Typed option: `tool_choice?: BetaToolChoiceAny | BetaToolChoiceTool | BetaToolChoiceAuto` ([`src/text/text-provider-options.ts` L273–275](https://github.com/TanStack/ai/blob/ec85900b2fd399ef981030246c3dc286b128ccc1/packages/ai-anthropic/src/text/text-provider-options.ts#L273-L275)). The type has no `none` variant.
- The adapter copies `tool_choice` from `modelOptions` into the request; a plain string is wrapped as `{ type: value }` ([`src/adapters/text.ts` L550–605](https://github.com/TanStack/ai/blob/ec85900b2fd399ef981030246c3dc286b128ccc1/packages/ai-anthropic/src/adapters/text.ts#L550-L605)). Keys not in its allow-list are dropped with a logged error.
- The adapter itself forces a tool only for its non-streaming structured-output path: `tool_choice: { type: 'tool', name: 'structured_output' }` ([`src/adapters/text.ts` L468–474](https://github.com/TanStack/ai/blob/ec85900b2fd399ef981030246c3dc286b128ccc1/packages/ai-anthropic/src/adapters/text.ts#L468-L474)).
- **What the Anthropic API does with it** ([Define tools: Forcing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)):
  - The options are `auto` (the default when tools are given), `any` ("must use one of the provided tools"), `tool` ("forces Claude to always use a particular tool") and `none`.
  - "Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1, and Claude Mythos 5.1": `any` and `tool` "return a 400 error". The docs suggest `auto` with strict tool use, or structured outputs, instead.
  - Manual extended thinking (`thinking: {type: "enabled"}`): `any` and `tool` "are not supported and result in an error". Adaptive thinking does not block forcing, "but a forced call skips thinking".
  - "When you have `tool_choice` as `any` or `tool`, the API prefills the assistant message to force a tool to be used. This means that the models will not emit a natural language response or explanation before `tool_use` content blocks, even if explicitly asked to do so."
  - Changing `tool_choice` invalidates cached message blocks (tool definitions and system prompts stay cached).

### OpenAI (`@tanstack/ai-openai` 0.28.0, Responses API)

- Typed option: `tool_choice?: 'auto' | 'none' | 'required' | ToolChoice` ([`src/text/text-provider-options.ts` L213–234](https://github.com/TanStack/ai/blob/410d8eb2198c71b57e83e768bdbd72b46ec35778/packages/ai-openai/src/text/text-provider-options.ts#L213-L234)), next to `parallel_tool_calls` and `max_tool_calls`. `ToolChoice` includes `{ type: 'function', name }` ([`openai-base/src/tools/tool-choice.ts`](https://github.com/TanStack/ai/blob/410d8eb2198c71b57e83e768bdbd72b46ec35778/packages/openai-base/src/tools/tool-choice.ts)).
- `OpenAIToolsOptions` is part of the per-model option types in `model-meta.ts` (100 occurrences across about 80 model entries in the installed copy). I did not check which models leave it out.
- The OpenAI text adapter delegates to `openai-base`'s Responses adapter, which spreads `...modelOptions` into the `responses.create` request before layering the engine-managed fields (`model`, `metadata`, `instructions`, `input`, `tools`) on top ([`openai-base/src/adapters/responses-text.ts`](https://github.com/TanStack/ai/blob/410d8eb2198c71b57e83e768bdbd72b46ec35778/packages/openai-base/src/adapters/responses-text.ts), installed L2212–2232). `tool_choice` is therefore passed through unchanged.
- **Unverified here:** what the OpenAI API does with `required` or a named function (for example, whether text can come alongside). I did not fetch OpenAI's docs; the adapter's comment links [platform.openai.com/docs/guides/tools/tool-choice](https://platform.openai.com/docs/guides/tools/tool-choice).

### In this repo

- `packages/bot-sdk/plugins/assistant/server/chat/run.ts` (on `origin/main` at `7de2c98c`) calls `chat({ adapter, messages, abortController, context, tools, systemPrompts, modelOptions: plan.modelOptions, middleware, … })`. It sets no `tool_choice` and no `agentLoopStrategy`, so the default `maxIterations(5)` applies ([CHAT] L1003–1004).
- A search of `packages/` on `origin/main` finds no `tool_choice`, `agentLoopStrategy` or `onShouldContinue`. The only hit is a test fixture listing `tool_choice` as a supported parameter (`packages/bot-sdk/test/core/server/chat/live-models.test.ts:26`).
- The existing middleware `artifactCutOff` already uses `onConfig` to rewrite `messages` per call (`packages/bot-sdk/plugins/assistant/server/chat/artifact-tool.ts:278`).

## 2. Stopping right after a given tool call

### How the loop is built

- `chat()`'s loop alternates two half-cycles: `processText` (one model call) and `executeToolCalls` (the tool phase). `endCycle()` flips from `processText` to `executeToolCalls`, and from `executeToolCalls` back to `processText` with `iterationCount++` ([CHAT] L1523–1531). The loop is `do { … } while (await shouldContinue())` ([CHAT] L1326–1382).
- `shouldContinue()` ([CHAT] L3712–3737):
  - It always returns `true` right after a model call ("Always enter the tool-execution half-cycle after a model turn"), so the tool phase cannot be skipped by the strategy.
  - After the tool phase it evaluates `this.loopStrategy(state)` and `middlewareRunner.runOnShouldContinue(ctx, state)` (both are always run), and continues only if both are true **and** `toolPhase === 'continue'`.
- So a stop decided after the tool phase happens **after the tools ran and before the next model call**. That is the "one less step" shape: the SendToUser tool executes, its result is streamed, and no further model call is made.

### What the stop check can see

- `AgentLoopState` ([TYPES] L1074–1093): `iterationCount`, `messages`, `finishReason`, `toolCallCount` (cumulative) and `lastTurnToolCallCount`. It has **no** list of tool names for the last turn; the names are in `messages`. `addAssistantToolCallMessage` appends `{ role: 'assistant', content, toolCalls }` before the tools run ([CHAT] L2692–2716), and tool results are appended as `role: 'tool'` messages.
- `AgentLoopStrategy` is `(state) => boolean` ([TYPES] L1109). The built-ins are `maxIterations`, `untilFinishReason` and `combineStrategies` (AND) ([`agent-loop-strategies.ts`](https://github.com/TanStack/ai/blob/cc7c92a2569ec4ea28373734c89ab095b9b88d6a/packages/ai/src/activities/chat/agent-loop-strategies.ts)). None of them looks at tool names.
- Middleware `onShouldContinue(ctx, state)`: "Return `false` to stop further iterations … Does not abort the run: the stream finishes normally with the current messages. Use `ctx.abort()` only when you need a hard abort." ([MW] L750–768). Other hooks that exist: `onBeforeToolCall`, `onAfterToolCall`, `onToolPhaseComplete` ([MW] L797–809).

### Other ways the tool phase ends the run

- **A text-only turn** sets `toolPhase` to `'stop'` ([CHAT] L2312–2318), so a model turn with no tool calls always ends the run.
- **A tool that needs approval, client execution or input** pauses: the run ends with a `RUN_FINISHED` interrupt and `toolPhase = 'wait'` ([CHAT] L2276–2302). The repo already uses this for approvals (ADR 0008, `awaiting` in `run.ts`). That ends the run "waiting", not "finished".
- **Middleware `ctx.abort()`** stops it as a cancellation (`toolPhase = 'stop'`, [CHAT] L2258–2261).
- `toolExecution: 'parallel'` (the default) runs all server tools of one turn together ([TYPES] L1143–1147). If the model emits SendToUser and another tool in the same turn, both run before the stop check.

### Not verified

- I did not run a `chat()` call that stops after a tool, so the exact final `RUN_FINISHED` `finishReason` (expected `tool_calls`) and the order of the deferred `RUN_FINISHED` chunks in that case are read from the code, not observed.

## 3. How plain text comes back, apart from tool calls

- **On the stream (AG-UI events):** assistant text arrives as `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` (with `delta`) and `TEXT_MESSAGE_END`. Tool calls arrive as `TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END` (the event types are in [TYPES], e.g. `TOOL_CALL_START` L1429, `TOOL_CALL_END` L1449), and tool results as `TOOL_CALL_RESULT` events (e.g. [CHAT] L1965, L3496). Each is a separate event type, so a consumer can route text and tool calls apart.
- **In the history:** an assistant `ModelMessage` has `content: string | null | Array<ContentPart>` for text and `toolCalls?: Array<ToolCall>` for calls ([TYPES] L374–399). When a turn has both, they live on the same message: `content: this.accumulatedContent || null, toolCalls` ([CHAT] L2700–2713). With provider-executed tools and thinking, the engine can split one turn into ordered segments with `${id}-segment-${n}` ids (`buildOrderedAssistantSegments`, [CHAT] L2610–2622).
- **The text stays in the history the model sees next turn.** Keeping it private from the user is up to the consumer of the stream and of the stored messages; `chat()` has no "private text" flag.
- **In this repo today:** the stream loop in `run.ts` does `parts.add(chunk)` for every chunk and `if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) runText += chunk.delta` (on `origin/main`, around L156–159), and appends every chunk to `assistantState(deps).runStreams`.
- With Anthropic forced tool use (where accepted), there is no text before the `tool_use` block (section 1). With `auto`, Claude "often comments on what it's doing or responds naturally to the user before calling tools" ([Define tools: Model responses with tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)).

## 4. How the open-source agents do it, at the level of the loop

Sources as linked in [How open-source always-on agents work](https://github.com/Daanish2003/ai-chat/blob/research/open-source-always-on-agents/docs/research/always-on-agent/open-source-always-on-agents.md) ([#389](https://github.com/Daanish2003/ai-chat/issues/389)), plus the files named below.

### Letta Code: `MessageChannel` (commit `1297870`)

- The tool description: when a `<channel-notification>` arrives, reply with this tool, because "A normal assistant response is not delivered back to the external channel automatically" ([`src/tools/descriptions/MessageChannel.md`](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/tools/descriptions/MessageChannel.md)).
- When the tool is scoped to one routed channel turn (`scoped` option), `buildMessageChannelDescriptionFromDiscovery` adds a contract to the description: "This tool is currently scoped to a routed external channel turn", "your final action for the turn must be one MessageChannel call" with `action="send"`, and after the send succeeds, do not repeat the message in assistant text but "finish with only `Sent.` as the internal confirmation". If no reply fits, don't call the tool ([`src/channels/message-channel-tool-definition.ts`](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/channels/message-channel-tool-definition.ts)).
- **What this means for the loop:** the send is followed by another model output (`Sent.`), so the loop does not end at the tool call; the contract is in the prompt. The tool definition sets no terminal flag (`auto_background: false` is the only flag besides name and label). Plain text is private because the channel only receives what the tool sends.
- The channels README: "Inbound channel delivery and user-visible replies are separate steps", and "the agent still has to call `MessageChannel` to reply" ([`src/channels/README.md`](https://github.com/letta-ai/letta-code/blob/1297870b0aa6662d6c70729d273f5073c1bcbdea/src/channels/README.md)).
- **Unverified:** where the model loop runs (Letta server vs in-process `--backend local`) and whether it applies any tool rule to `MessageChannel`; I found none in the files above.

### Classic Letta / MemGPT (history, commit `56ba9c2`)

- `send_message` was a tool. `REQUEST_HEARTBEAT_DESCRIPTION`: "If set to `False` (the default), then the chain of execution will end immediately after this function call" ([`letta/constants.py` L217–218](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/constants.py#L217-L218)).
- `TerminalToolRule`: "if this tool gets called, it must end the agent loop" ([`letta/schemas/tool_rule.py` L275–280](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/schemas/tool_rule.py#L275-L280)). `RequiredBeforeExitToolRule`: "this tool must be called before the agent loop can exit".
- By default the agent manager gave `send_message`, `send_message_to_agent_async` and `memory_finish_edits` a `TerminalToolRule`, and the other base tools a `ContinueToolRule` ([`letta/services/agent_manager.py` L480–485](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/services/agent_manager.py#L480-L485)). This is the "loop ends at the send" shape, done by the loop rather than the prompt.

### OpenClaw: `visibleReplies: "message_tool"` and `NO_REPLY` (commit `3aa6420`, plus `main`)

- Config: `messages.groupChat.visibleReplies` defaults to `"automatic"`. With `"message_tool"`, "visible answers must go through `message(action=send)`". "This selects the delivery method, not whether a reply is required." If the model "returns substantive final text" without the tool, "OpenClaw keeps that text private" and "attempts a bounded delivery recovery rather than posting it directly". If the message tool is unavailable under the tool policy, it falls back to automatic. Command turns always reply visibly ([`docs/channels/groups.md`](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/channels/groups.md)).
- Mode resolution: `resolveSourceReplyDeliveryMode` returns `"automatic"` or `"message_tool_only"`; `room_event` inbound (ambient rooms) is always `"message_tool_only"`. `resolveSourceReplyVisibilityPolicy` turns the mode into flags such as `suppressAutomaticSourceDelivery`. The file decides delivery only; it does not touch the loop or the final text ([`src/auto-reply/reply/source-reply-delivery-mode.ts`](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/src/auto-reply/reply/source-reply-delivery-mode.ts)).
- The embedded runner maps `visibleReplies === "message_tool"` to `"message_tool_only"` and sets `params.forceMessageTool = mode === "message_tool_only"` ([`src/agents/embedded-agent-runner/run/runtime.ts` on `main`](https://github.com/openclaw/openclaw/blob/main/src/agents/embedded-agent-runner/run/runtime.ts); this file is not at `3aa6420`). In `src/agents/agent-tools.ts` (`main`), `forceMessageTool` feeds the list of tools kept for lean local models; I found no provider `tool_choice` set from it there. **Unverified:** whether `forceMessageTool` forces `tool_choice` anywhere else.
- Silence: "Only a completed final whose entire text is uppercase `NO_REPLY` … requests silence"; it "intentionally ends a turn without another reply, including after a cross-chat send, a reaction"; "`NO_REPLY` discards anything written this turn that was not sent" ([`docs/concepts/messages.md`](https://github.com/openclaw/openclaw/blob/3aa642027ea1466c4694ad6950653c4de3740644/docs/concepts/messages.md)). In `groups.md`: "Empty or reasoning-only model output is not equivalent to `NO_REPLY` and retains recovery." So `NO_REPLY` is itself a final model output, one model call after any send.
- **One documented loop stop after a tool:** for WebChat prompt reactions, `message` with `action: "react"` and `final: true` can be the whole reply, and "once delivery is confirmed on the current source message, OpenClaw ends the turn without requesting another text response" (`docs/concepts/messages.md`, section "Agent reactions to WebChat prompts"). Omitting `final` means more work follows.
- **Unverified:** whether a `message(action=send)` in `message_tool_only` mode ends the turn without another model call. The docs and the three source files above do not say.

## Gaps and things I could not verify

- No `chat()` run was executed; the loop behaviour in section 2 is read from the 0.66.0 source.
- OpenAI's own semantics for `tool_choice: 'required'` and a named function (and whether text can accompany a forced call) were not fetched.
- Which OpenAI model entries in `model-meta.ts` omit `OpenAIToolsOptions` was not checked.
- Which Anthropic models in the repo's catalogue reject forced tool use was not cross-checked against Anthropic's list above.
- OpenClaw's loop after `message(action=send)`, and what `forceMessageTool` does beyond tool-list policy, are unverified; some OpenClaw links point at `main`, not a pinned commit.
- Letta Code's server-side loop handling of `MessageChannel` (any tool rule) is unverified.
