# TanStack adapters and the provider computer toolsets

Research for [#562](https://github.com/Daanish2003/ai-chat/issues/562), a child of map [#417](https://github.com/Daanish2003/ai-chat/issues/417) (Bot step 6, Helpers). Facts only, no pick.

Read on 2026-10-19. Sources:

- Package source from the npm registry tarballs (each ships `src/`), at the versions the repo pins and at `latest`:

  | Package                  | Pinned (`packages/bot-sdk/package.json`, `pnpm-lock.yaml`) | Latest (`dist-tags.latest`, published) |
  | ------------------------ | ---------------------------------------------------------- | -------------------------------------- |
  | `@tanstack/ai`           | `0.66.0`                                                   | `0.69.0` (2026-10-13)                  |
  | `@tanstack/ai-anthropic` | `0.20.0`                                                   | `0.22.0` (2026-10-13)                  |
  | `@tanstack/ai-openai`    | `0.28.0`                                                   | `0.30.0` (2026-10-13)                  |
  | `@tanstack/openai-base`  | `0.12.6` (lockfile, via `ai-openai`)                       | `0.14.0` (2026-10-13)                  |
  | `@anthropic-ai/sdk`      | `0.97.1` (lockfile, via `ai-anthropic`)                    | `0.135.0`                              |
  | `openai`                 | `7.30.0` (lockfile, via `openai-base`)                     | `7.39.0`                               |

  Links below use `ANT@v/` for `https://unpkg.com/@tanstack/ai-anthropic@v/src/`, `OB@v/` for `@tanstack/openai-base`, `OAI@v/` for `@tanstack/ai-openai` and `CORE@v/` for `@tanstack/ai`. Line numbers are from those files.

- Anthropic, [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) [A1].
- OpenAI, [Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) [O1].

Earlier findings not repeated here: [Computer-use control stack](https://github.com/Daanish2003/ai-chat/issues/390) ([doc](https://github.com/Daanish2003/ai-chat/blob/research/computer-use-control/docs/research/always-on-agent/computer-use-control.md)). It read the pinned versions only and left the OpenAI adapter's image tool results unchecked.

## Summary

- **Neither adapter drives the current provider computer tools, pinned or latest.** Nothing touching computer use changed between the pinned and latest versions: `src/tools/` of `ai-anthropic` is byte-identical between `0.20.0` and `0.22.0`, and `openai-base`'s `computer-use-tool.ts`, `tool-converter.ts` and `responses-user-tools.ts` are unchanged between `0.12.6` and `0.14.0`.
- **Anthropic:** no code handles `toolset_name`. A computer toolset entry can reach the wire (the converter passes the tool's metadata through as is), but its calls come back named `left_click`, `screenshot` and so on, and every `tool_result` must echo `"toolset_name": "computer"`, which the adapter never writes. So the loop fails on the first result.
- **OpenAI:** the converter hard-codes `type: "computer_use_preview"`, and no code reads a `computer_call` item. The adapter does have a seam for app-run provider tools (`shell`, `apply_patch`, `local_shell`), and a `computer` patch would follow it.
- **No patch-free route exists through the adapters' public options.** Neither adapter passes raw `tools` through `modelOptions`. The only other seam is the SDK client's `fetch` (both client configs extend the SDK `ClientOptions`), which would have to rewrite requests and the streamed responses.
- **Custom `toolDefinition` returning a screenshot works on both adapters, pinned and latest.** Core passes a `ContentPart[]` result through unchanged. Anthropic maps it to `tool_result.content` image blocks. OpenAI Responses maps it to a `function_call_output` whose `output` is a list with `input_image`. Chat Completions sends the images in a separate user message.

## 1. Anthropic: `@tanstack/ai-anthropic`

### What the API wants [A1]

- Declare `{"type": "computer_toolset_20260801"}` in `tools`. It needs no beta header. Its fields are `type`, `configs` (per-member overrides such as `{ zoom: { enabled: false } }`), `cache_control` and `allowed_callers`. It rejects `display_width_px`, `display_height_px` and `display_number`: "coordinates are always in the pixel space of the screenshots you return", and oversized images are rejected, not downscaled.
- Each call is a `tool_use` block "whose `name` is the member and which carry `"toolset_name": "computer"`", and its `input` holds "only that member's parameters, with no `action` field", e.g. `{"name": "left_click", "toolset_name": "computer", "input": {"coordinate": [512, 742]}}`.
- "Every result for a member tool must carry `"toolset_name": "computer"`; a result that omits it, or that names a different toolset than its `tool_use` block, is rejected." Only `screenshot` and `zoom` need an image. The others can return text such as `OK`.
- Models: the page's list is `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-5-5`. "On the Claude API and Google Cloud, Claude 5.5 and later models support computer use only through the `computer_toolset_20260801` toolset and return an error for the earlier `computer_20251124` and `computer_20250124` tool versions." On Bedrock, the 5.5 models still accept `computer_20251124`. Opus 4.7/4.6/4.5 and Sonnet 4.6 support only `computer_20251124` (beta header).

### What the adapter does (same in `0.20.0` and `0.22.0`)

- **Sending the tool.** `computerUseTool(config)` brands a tool named `computer` whose config type is `BetaToolComputerUse20241022 | BetaToolComputerUse20250124` ([ANT@0.22.0/tools/computer-use-tool.ts L11-L40](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/tools/computer-use-tool.ts)). The converter returns the tool's `metadata` minus the internal `__kind` marker, with no other change ([L20-L27](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/tools/computer-use-tool.ts); [anthropic-provider-tool.ts L61-L68](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/tools/anthropic-provider-tool.ts)). So `computerUseTool({ type: "computer_toolset_20260801" } as never)` would put the toolset entry on the wire unchanged. The type check is only a cast away.
- **Type gating.** `model-meta.ts` leaves `computer_use` off `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, with the comment "this model accepts only `computer_toolset_20260801`, and `computerUseTool()` sends the older versions, which return a 400" ([ANT@0.22.0/model-meta.ts L684, L731, L774](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/model-meta.ts)). The brand is type-only: `brandProviderTool` is a plain cast ([CORE@0.69.0/tools/provider-tool.ts L35-L39](https://unpkg.com/@tanstack/ai@0.69.0/src/tools/provider-tool.ts)).
- **Betas.** `computeAnthropicBetas()` adds headers for files, mid-conversation tool changes, interleaved thinking, context management, MCP, code execution and skills. It adds none for computer use ([ANT@0.22.0/adapters/text.ts L224-L294](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/adapters/text.ts)). The toolset needs none.
- **Parsing calls.** On `content_block_start` with `type === 'tool_use'`, the adapter keeps `id` and `name` only ([text.ts L1575-L1582](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/adapters/text.ts); `0.20.0` L1130). `toolset_name` is dropped. A toolset call therefore reaches core as a tool call named `left_click` (or another member).
- **Running calls.** Core finds the tool by `toolCall.function.name`. With no tool of that name it returns `{ error: "Unknown tool: <name>" }` ([CORE@0.69.0/activities/chat/tools/tool-calls.ts L1049-L1060](https://unpkg.com/@tanstack/ai@0.69.0/src/activities/chat/tools/tool-calls.ts); `0.66.0` L1004). The registered tool is named `computer`, so its `execute` is never reached for a member call.
- **Replaying calls.** `appendToolCallBlocks()` writes `{ type: 'tool_use', id, name, input }`, with no `toolset_name` ([text.ts L1408-L1414](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/adapters/text.ts); `0.20.0` L890).
- **Results.** A `role: 'tool'` message becomes `{ type: 'tool_result', tool_use_id, content, is_error? }`, with no `toolset_name` ([text.ts L1219-L1236](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/adapters/text.ts); `0.20.0` L823-L842). The API rejects this for a toolset member [A1].
- **SDK types.** `@anthropic-ai/sdk@0.97.1` (pinned) has no `computer_toolset_20260801` type and no `toolset_name` field. It knows `computer_20241022`, `computer_20250124` and `computer_20251124`. `0.135.0` has `BetaComputerToolset20260801` (`type`, `cache_control`, `configs`), 17 typed member `tool_use` blocks with `toolset_name: 'computer'`, and `toolset_name?: string | null` on `BetaToolUseBlockParam`.
- **No raw `tools` passthrough.** `modelOptions` keys copied to the request are `cache_control`, `container`, `context_management`, `mcp_servers`, `service_tier`, `stop_sequences`, `tool_choice`, `top_k`, `temperature`, `top_p`. Others are dropped with a logged error ([text.ts L813-L866](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/adapters/text.ts)).

### What a patch would have to change

The adapter keeps no record of a call's toolset, so a `pnpm patch` touches four places in `adapters/text.ts`, plus types:

1. Declare the toolset. No code change is needed: a `computer_use`-kind tool whose metadata is `{ type: "computer_toolset_20260801", configs? }` is sent verbatim (cast, or widen `ComputerUseToolConfig`).
2. Parse: when a `tool_use` block has `toolset_name`, keep it, and route the call to one registered tool (e.g. name `computer`, input `{ action: <member>, ...input }`) or to per-member tools. It must record the member and toolset on the call's `metadata`, as the adapter already does for server tools.
3. Replay: write the member `name` and `toolset_name` back on the `tool_use` block.
4. Results: add `toolset_name` to the `tool_result` for that call.
5. Types: the pinned SDK lacks the toolset types, so the patch casts, or `@anthropic-ai/sdk` moves up (a dependency change).

Models this would cover on the direct Anthropic adapter, among the repo's models (`packages/bot-sdk/plugins/models/shared/models-snapshot.ts`): `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1` (all in [A1]'s list). `claude-haiku-4-5` is in the snapshot but not in [A1]'s toolset list. Routes through OpenRouter, Vercel Gateway or Bedrock use other adapters and are not covered.

The repo already patches two TanStack packages this way (`pnpm-workspace.yaml` `patchedDependencies`: `@tanstack/ai-mistral@0.6.15`, `@tanstack/ai-ollama@0.11.14`, files under `patches/`).

## 2. OpenAI: `@tanstack/openai-base` (used by `@tanstack/ai-openai`)

### What the API wants [O1]

- Tool `{ "type": "computer" }`, with no display or environment fields. The examples use `gpt-6.1-sol`. The guide lists no models. It says to check each model's Tools section.
- The model returns a `computer_call` item with `call_id`, an ordered `actions` array (`click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, `screenshot`) and `status`. `completed` means the call is fully generated. The app still runs it.
- The app replies with `{ "type": "computer_call_output", "call_id", "output": { "type": "computer_screenshot", "image_url": "data:image/png;base64,...", "detail": "original" } }`. The example passes `previous_response_id`. The guide does not say whether replaying full input instead works.
- "Pending API safety checks stop this sample". The SDK types carry `pending_safety_checks` on the call and `acknowledged_safety_checks` on the output (`openai@7.30.0` `resources/responses/responses.d.ts`, `ResponseComputerToolCall`, `ResponseComputerToolCallOutputItem`).
- The pinned `openai@7.30.0` types already have `ComputerTool { type: 'computer' }`, `actions?: ComputerActionList` on `ResponseComputerToolCall`, and `ResponseComputerToolCallOutputScreenshot { type: 'computer_screenshot', file_id?, image_url? }`. That type has no `detail` field.

### What the adapter does (same in `0.12.6` and `0.14.0`)

- **Sending the tool.** `convertComputerUseToolToAdapterFormat()` always returns `{ type: 'computer_use_preview', display_height, display_width, environment }`, and `computerUseTool()` names the tool `computer_use_preview` ([OB@0.14.0/tools/computer-use-tool.ts L16-L45](https://unpkg.com/@tanstack/openai-base@0.14.0/src/tools/computer-use-tool.ts)). Unlike Anthropic's, this converter rebuilds the object, so a cast metadata cannot change the `type`.
- **Type gating.** `@tanstack/ai-openai` lists `computer_use` for `gpt-5.4-mini`, `gpt-5.6`, `gpt-6-luna` and `gpt-6.1-sol`, among others ([OAI@0.30.0/model-meta.ts](https://unpkg.com/@tanstack/ai-openai@0.30.0/src/model-meta.ts)). That brand means the legacy `computer_use_preview` tool at runtime ([OAI@0.30.0/tools/computer-use-tool.ts](https://unpkg.com/@tanstack/ai-openai@0.30.0/src/tools/computer-use-tool.ts)).
- **Parsing calls.** `computer_call` and `'computer'` appear nowhere in `openai-base` `src` (excluding tests). The stream handles `message`, `reasoning`, `function_call`, `web_search_call`, `compaction` and the app-run tool calls below.
- **App-run provider tools (the template a patch would follow).** `responses-user-tools.ts` defines `OpenAIUserToolName = 'shell' | 'apply_patch' | 'local_shell'`. `readUserExecutedCall()` turns those output items into a call `{ name, callId, itemId, input }`. The stream emits it as a TanStack tool call with `metadata.openaiUserTool`, so core runs the app's tool of that name. `userToolRequestItem()` replays the call as its native item, and `userToolResultItem()` turns the tool's result into the native output item, e.g. `shell_call_output` ([OB@0.14.0/adapters/responses-user-tools.ts](https://unpkg.com/@tanstack/openai-base@0.14.0/src/adapters/responses-user-tools.ts); wiring in [responses-text.ts L1538-L1575, L2977](https://unpkg.com/@tanstack/openai-base@0.14.0/src/adapters/responses-text.ts)). The same file and wiring exist in `0.12.6` (`responses-text.ts` L1210, L2051).
- **No raw `tools` passthrough.** The tool converter switches on the provider tool kind. The `custom` kind is OpenAI's freeform `type: 'custom'` tool, not a passthrough ([OB@0.14.0/tools/tool-converter.ts](https://unpkg.com/@tanstack/openai-base@0.14.0/src/tools/tool-converter.ts); [custom-tool.ts](https://unpkg.com/@tanstack/openai-base@0.14.0/src/tools/custom-tool.ts)).

### What a patch would have to change

1. `computer-use-tool.ts`: emit `{ type: 'computer' }` and name the tool `computer`.
2. `responses-user-tools.ts`: add `'computer'` to `OpenAIUserToolName`. In `readUserExecutedCall()`, map a `computer_call` to `{ name: 'computer', callId, itemId, input: { actions, pending_safety_checks } }`. `userToolRequestItem()` replays it as a `computer_call`. `userToolResultItem()` builds `computer_call_output` with a `computer_screenshot` from the tool's image part (data URL), plus `acknowledged_safety_checks` when the app acknowledged them.
3. `responses-text.ts`: the call sites above already route any user tool name through these helpers, so they need no new branch unless the result (an image `ContentPart[]`) needs different parsing from the text the shell path expects.

It covers the direct OpenAI adapter (`createOpenaiChat`) for models that accept `{ type: "computer" }`. [O1] confirms `gpt-6.1-sol` only by example. Which of the repo's other OpenAI models (`gpt-6-luna`, `gpt-5.6`, `gpt-5.4-mini`) accept it was not checked against OpenAI's model pages.

## 3. The `fetch` seam (no patch)

- `AnthropicClientConfig` extends the Anthropic SDK `ClientOptions` (`0.20.0`: `extends ClientOptions`. `0.22.0`: `Omit<ClientOptions, 'apiKey' | 'authToken'>`) ([ANT@0.22.0/utils/client.ts](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/utils/client.ts)). `OpenAIClientConfig` extends `Omit<ClientOptions, 'apiKey'>` ([OAI@0.28.0/utils/client.ts](https://unpkg.com/@tanstack/ai-openai@0.28.0/src/utils/client.ts)). Both accept a custom `fetch`.
- Latest core (`0.69.0`) also has a per-call `wrapFetch` option in `TextOptions` ([CORE@0.69.0/types.ts L1450-L1452](https://unpkg.com/@tanstack/ai@0.69.0/src/types.ts)). It is not in the pinned `0.66.0`.
- To drive a toolset through it, the fetch would rewrite the request JSON (tools, `toolset_name` on replayed `tool_use` and `tool_result`; or `computer_call` / `computer_call_output` items) and the SSE response (renaming member calls or `computer_call` items into something the adapter parses). This is a wire-level shim, not a TanStack seam.

## 4. Screenshot as an image `ContentPart` from a custom `toolDefinition` (the `xdotool` path)

- **Core.** `normalizeToolResult()` returns a string as is, a non-empty array of content parts as is, and `JSON.stringify`s anything else ([CORE@0.69.0/utilities/tool-result.ts L57-L61, L96-L102](https://unpkg.com/@tanstack/ai@0.69.0/src/utilities/tool-result.ts); same in `0.66.0`). The `ContentPart[]` becomes the `role: 'tool'` message's `content`, which "the adapters convert to structured provider output on the next iteration" ([CORE@0.69.0/activities/chat/index.ts L3980-L3986](https://unpkg.com/@tanstack/ai@0.69.0/src/activities/chat/index.ts)).
- **Anthropic.** `tool_result.content` is the parts mapped by `convertContentPartToAnthropic()`. An `image` part with a `data` source becomes `{ type: 'image', source: { type: 'base64', data, media_type } }`, and a `url` source becomes a URL image ([ANT@0.22.0/adapters/text.ts L1100-L1147, L1219-L1236](https://unpkg.com/@tanstack/ai-anthropic@0.22.0/src/adapters/text.ts); `0.20.0` L727, L823-L842). **Works, pinned and latest.**
- **OpenAI Responses (`createOpenaiChat`).** A `role: 'tool'` message with array content becomes `{ type: 'function_call_output', call_id, output: [...] }`, each part through `convertContentPartToInput()`. An image becomes `{ type: 'input_image', image_url: 'data:<mime>;base64,<data>' (or the URL), detail: metadata.detail ?? 'auto' }` ([OB@0.14.0/adapters/responses-text.ts L2838-L2870, L3084-L3125](https://unpkg.com/@tanstack/openai-base@0.14.0/src/adapters/responses-text.ts)). **Works, pinned and latest.** Differences:
  - `0.12.6` maps every part ([responses-text.ts L2285-L2296](https://unpkg.com/@tanstack/openai-base@0.12.6/src/adapters/responses-text.ts)).
  - `0.14.0` drops image parts when the model's `inputModalities` lacks `image`. If that leaves nothing, it sends `'(image omitted: this model has no image input)'`.
  - `detail` defaults to `auto`. [O1]'s native screenshot uses `original`, which a custom tool can set via the image part's `metadata.detail` only if the adapter's type (`'auto' | 'low' | 'high'`) allows it. Here it does not, so `original` would need a cast.
- **OpenAI Chat Completions adapter** (`text-chat-completions.ts`, used by OpenAI-compatible providers): a `tool` message carries text only. Image parts from tool results are collected and sent in one `user` message after the tool results, when the model has image input ([OB@0.14.0/adapters/chat-completions-text.ts L1449-L1460, L1547-L1560](https://unpkg.com/@tanstack/openai-base@0.14.0/src/adapters/chat-completions-text.ts)).

## Open points

- Whether OpenAI accepts full-input replay of `computer_call` / `computer_call_output` without `previous_response_id` ([O1] shows only the latter). The adapter replays full input.
- Which OpenAI models besides `gpt-6.1-sol` accept `{ type: "computer" }`.
- `claude-opus-4-8` is in [A1]'s list, but the page does not say which tool version it takes.
- Whether the repo's Turn persistence keeps a tool result's `ContentPart[]` (image) intact between runner jobs was not checked. This research covered only the adapters.
