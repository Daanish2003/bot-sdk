# Computer-use control stack

Research for [#390](https://github.com/Daanish2003/ai-chat/issues/390) (child of map [#383](https://github.com/Daanish2003/ai-chat/issues/383)). Researched 2026-10-16. Facts only; no recommendation.

## Question

What stack can drive the computer the three ways the lecture names (slide 26, "Three ways to use a computer")?

1. Read the page structure (accessibility tree or ARIA snapshot) and click elements directly.
2. Click on pixels on a 1280×800 screen.
3. Hand the screen to a person for logins, codes and captchas.

Compare Playwright ARIA snapshots, Stagehand, browser-use, Anthropic computer use and OpenAI's computer-use model. Cover how each fits TanStack AI, and the token cost per step.

## Summary

- **Way 1 (page structure).** Playwright `page.ariaSnapshot({ mode: "ai" })` returns a YAML accessibility tree with `[ref=e2]` refs, and `page.getByRef()` clicks by ref [P2][P3]. Anthropic's `browser_toolset_20260801` is the same idea as a model-side toolset: `read_page` returns the tree with `[ref_2]` refs and clicks accept `{"type":"ref"}` [A2]. Stagehand reads a trimmed accessibility tree [S1]. browser-use sends indexed DOM elements plus a screenshot [B2].
- **Way 2 (pixels).** Anthropic `computer_toolset_20260801` (17 actions, GA, no beta header) and OpenAI `{ type: "computer" }` (batched `actions[]`) are both client-executed: the app runs the actions and returns a screenshot [A1][O1]. Anthropic lists 1280×800 as a recommended web size [A1].
- **Way 3 (hand to a person).** No tool in this list ships a "take over the screen" feature in the pages read. Both providers say when to stop and ask: OpenAI says always confirm before solving a captcha and hand off the last step of a password change [O2]; Anthropic says confirm consequential actions and never give the model credentials [A1]. In TanStack AI the pause points are `needsApproval` and client tools (a tool with no `execute`) [T3].
- **TanStack AI fit.** The installed adapters can't drive the current provider computer tools. `@tanstack/ai-anthropic@0.20.0` `computerUseTool()` only types `computer_20241022` / `computer_20250124`, sends no beta header, and its own model metadata says Claude 5.5 models reject it with a 400 [T1]. `@tanstack/openai-base@0.12.6` only emits the legacy `computer_use_preview` tool and doesn't parse `computer_call` output items [T2]. Custom `toolDefinition` tools backed by Playwright work on every adapter; `execute` may return a content-part array, so a screenshot can go back as an image [T3].
- **Tokens per step.** A 1280×800 screenshot is about 1,334 tokens on current Claude models and 1,200 on OpenAI patch models (worked below). The Anthropic computer toolset adds about 4,500 input tokens to each request [A1]. An accessibility-tree read has no fixed size; Anthropic says a typical tree read "often costs fewer input tokens than a screenshot" and caps `read_page` at 50,000 characters [A2].

## Comparison

| Option                                | Way it covers                           | What the model sees                                                                                   | Who runs it                                            | Language                                                 | TanStack AI fit (installed versions)                                                                                                                 |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright `ariaSnapshot`             | 1 (and 2 via `page.mouse`, screenshots) | YAML accessibility tree; `mode: "ai"` adds `[ref=eN]`, iframes; `boxes` adds `[box=x,y,w,h]` [P2][P3] | Your code                                              | TS/JS (also Python, Java, .NET)                          | Wrap as custom `toolDefinition(...).server(execute)`; works on every adapter. Repo already has `@playwright/test ^1.63.0` in `apps/web` (tests only) |
| Stagehand (Browserbase)               | 1, 2, hybrid                            | "Hybrid accessibility-tree trimming" [S1]; agent `ariaTree` tool; CUA mode uses coordinates [S3]      | Your code (CDP, no Playwright dependency) [S2]         | TS, Python, Go; MIT [S1]                                 | Its own LLM loop (`agent`, `act`) or deterministic `page` methods; can sit behind custom tools. Not a TanStack adapter                               |
| browser-use                           | 1 + vision                              | `[index]<tag attr=... />` interactive elements plus a screenshot with bounding boxes [B2]             | Your code (or Browser Use Cloud)                       | Python library; MIT; hosted SDK has a TS client [B1][B3] | Python, so only reachable as a separate service or the hosted API                                                                                    |
| Anthropic `browser_toolset_20260801`  | 1 (+ coordinates)                       | `read_page` tree with `[ref_N]`, `find`, screenshots [A2]                                             | Your executor; "nothing runs on Anthropic's side" [A2] | Any                                                      | Not supported by `@tanstack/ai-anthropic@0.20.0` (no toolset code in `src`) [T1]                                                                     |
| Anthropic `computer_toolset_20260801` | 2                                       | Screenshots; 17 actions [A1]                                                                          | Your executor [A1]                                     | Any                                                      | Not supported by `@tanstack/ai-anthropic@0.20.0`; older `computerUseTool()` returns 400 on Claude 5.5 [T1]                                           |
| OpenAI `computer` tool                | 2                                       | Screenshots; `computer_call` with batched `actions[]` [O1][O2]                                        | Your executor [O1]                                     | Any                                                      | Not supported by `@tanstack/openai-base@0.12.6` (legacy `computer_use_preview` only, `computer_call` not parsed) [T2]                                |

## Way 1: read the page structure

### Playwright ARIA snapshots

- An ARIA snapshot is "a YAML representation of the accessibility tree of a page"; each node is `- role "name" [attribute=value]`, indentation shows nesting [P1].
- `locator.ariaSnapshot(options?)` returns `Promise<string>`. Options: `mode: "ai" | "default"` (1.59), `depth` (1.59), `boxes` (1.60), `signal` (1.62), `timeout` [P2]. In `"ai"` mode it includes element refs (`[ref=e2]`), includes `<iframe>` contents, and throws instead of waiting when nothing matches [P2].
- `page.ariaSnapshot()` was added in 1.59; `locator.ariaSnapshotJSON()` / `page.ariaSnapshotJSON()` in 1.63; `page.getByRef()` ("locates an element by its aria ref, such as `e2`, reported by `page.ariaSnapshot()` in the `'ai'` mode") in 1.64. 1.61 removed the older `Locator.ariaRef()` [P3].
- 1.62 bundles the Playwright MCP server and `playwright-cli` (`npx playwright mcp`) [P3]. The OpenAI computer-use guide's JavaScript code-execution example also drives the browser with Playwright [O1].
- The repo pins `@playwright/test ^1.63.0` in `apps/web/package.json`; `getByRef()` needs 1.64.

### Stagehand

- "TypeScript, Python, and Go monorepo", MIT; Go install pins `@v4.0.0`, docs are under `/v4/` [S1].
- Reads the page with "hybrid accessibility-tree trimming" [S1]. Drives the browser over CDP, "so there is no Playwright or Puppeteer dependency"; Chromium only [S2].
- Primitives: `act` (natural-language action), `extract` (schema), `observe` (returns `Action` objects with `description`, `method`, `arguments`, `selector`, e.g. an XPath). An observed action passed to `act()` replays "No LLM call" [S4].
- Server-side caching of `observe` results only applies on Browserbase browsers [S4]. Browserbase is "recommended, not required" [S2].
- Agent (v3 docs): DOM mode works with any LLM ("Non CUA agents are currently only supported in TypeScript"); `mode: "cua"` uses Google, OpenAI, Anthropic or Microsoft computer-use models; hybrid mode needs `experimental: true`. Default viewport 1288×711; default `maxSteps` 20; each run returns a `usage` object [S3].
- `stagehand-claude-sdk` (npm/PyPI) plugs a `StagehandBrowser` into the Anthropic SDK tool runner as the browser executor [S5].

### browser-use

- Open-source Python library (Python ≥ 3.11 in the README, 3.12 in the quickstart), MIT [B1][B3]. Hosted "Browser Use Cloud" has Python and npm `browser-use-sdk` clients with a different API from the library [B4].
- The system prompt shows interactive elements as `[index]<tagname attribute=value />`, text under them, tab-indented nesting; only indexed elements are actionable; `<browser_vision>` is a screenshot "with bounding boxes around interactive elements" [B2].
- `use_vision` defaults to `True` (always send screenshots); `"auto"` sends them only on request; `False` never. `max_actions_per_step` defaults to 5. `flash_mode` skips evaluation and thinking. `page_extraction_llm` can be a smaller model. `calculate_cost` tracks spend [B5].
- LLM classes include `ChatBrowserUse`, `ChatOpenAI`, `ChatAnthropic`, `ChatGoogle` [B3].

### Anthropic browser toolset

- `{"type": "browser_toolset_20260801"}`, GA on the Claude API and Google Cloud, no beta header shown; not in Claude Managed Agents [A2].
- Models: claude-fable-5-1, claude-mythos-5-1, claude-fable-5, claude-mythos-5, claude-opus-5-5, claude-opus-5, claude-sonnet-5-5, claude-sonnet-5, claude-opus-4-8, claude-haiku-5-5 [A2].
- `read_page` returns the tree with `[ref_N]` tags (`filter`: omitted, `"interactive"`, `"all"`; `depth` default 15; output capped at 50,000 characters). `find` returns up to 20 matches. Clicks take `{"type":"ref","ref":"ref_2"}` or `{"type":"coordinate",...}`. Also `navigate`, `screenshot`, `zoom`, `type`, `key`, `scroll`, `form_input`, `get_page_text`, tab tools; `javascript_exec`, `file_upload`, `read_console`, `read_network` are off by default [A2].
- Results must echo `"toolset_name": "browser"`. Can be declared together with the computer toolset [A2].

## Way 2: click on pixels

### Anthropic computer use

- Current: `{"type": "computer_toolset_20260801"}`, client toolset, no beta header, 17 members: `screenshot`, `zoom`, `cursor_position`, `mouse_move`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `type`, `key` (`repeat` 1–100), `hold_key`, `scroll`, `wait` [A1].
- Each `tool_use` has `name` = the action and `"toolset_name": "computer"`; return one `tool_result` per block echoing `toolset_name`, with only `text` and `image` content; run batched blocks in order and stop at the first failure [A1].
- Earlier versions (beta): `computer_20251124` (header `computer-use-2025-11-24`) and `computer_20250124` (header `computer-use-2025-01-24`). "Claude 5.5 and later models ... on the Claude API and Google Cloud ... accept only the toolset" [A1].
- Resolution: "for web applications, use 1280x800 or 1366x768"; avoid above 1920×1080. Toolset-era models allow 2576 px long edge and 4,784 visual tokens, tokens = `⌈width/28⌉ × ⌈height/28⌉`; oversized images are rejected, not downscaled [A1].
- Reference implementation is Docker-based (`anthropic-quickstarts/computer-use-demo`) [A1].

### OpenAI computer use

- Tool `{ type: "computer" }`; examples use `gpt-6.1-sol`. Loop: model returns `computer_call` with `actions[]`; app runs them, captures the screen, sends `computer_call_output` with a `computer_screenshot` (`image_url` data URL, `detail: "original"`) and `previous_response_id` [O1].
- Actions: `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, `screenshot` [O1].
- Migration from `computer-use-preview`: model to `gpt-6.1-sol`, tool `computer_use_preview` to `computer`, single `action` to batched `actions[]`, `truncation: "auto"` no longer needed; the GA example has no `display_width` / `display_height` / `environment` [O2].
- Screenshots: use `detail: "original"`; 1440×900 and 1600×900 "showed strong performance" when scaling down; remap coordinates [O2]. For GPT-6 Astra the guide recommends code execution and says the computer tool "remains supported as an alternative" [O1].

## Way 3: hand the screen to a person

- OpenAI: login is pre-approved only if the user's prompt asked for it, otherwise confirm; "Always confirm with the user at action time before solving" a captcha; the user must take over the final step of changing a password and any bypass of browser or site safety barriers; "The model's request to act is not user permission"; typing sensitive data counts as transmission [O2].
- Anthropic: dedicated VM or container; don't give the model credentials; domain allowlist; a human confirms consequential actions and anything needing consent (cookies, payments, terms) [A1]. Browser toolset: a fresh profile "that holds no credentials", and make the check "in your executor before each call, because one turn can carry several" [A2].
- Stagehand agent: an `AbortSignal` cancels a run; no approval or handoff feature on the agent page [S3]. browser-use: the library README says "no browser configuration guarantees that every CAPTCHA can be avoided or solved" and offers profile/cookie sync for auth [B1]; a Cloud "human-in-the-loop" page exists (not read for this ticket).
- TanStack AI pause points (`@tanstack/ai@0.66.0`): a tool with `needsApproval` produces an approval request; a tool with no `execute` produces a client-execution request, and the run waits for the client's result [T3]. This repo already routes approvals through `packages/chat-sdk/core/server/chat/approval.ts` and per-Conversation `allowedTools` (`host-tools.ts`).
- Not covered in the pages read: a live-view or remote-control stream that lets the person drive the same screen. That is a gap for a follow-up ticket.

## TanStack AI fit, in detail

Adapters are built in `packages/chat-sdk/core/server/chat/adapters.ts` (`createAnthropicChat`, `createOpenaiChat`, ...). Installed versions per `packages/chat-sdk/package.json`: `@tanstack/ai 0.66.0`, `@tanstack/ai-anthropic 0.20.0`; `@tanstack/ai-openai 0.28.0` resolves `@tanstack/openai-base 0.12.6`.

- **Anthropic provider tool** [T1]. `computerUseTool(config)` brands a tool named `computer` whose config type is `BetaToolComputerUse20241022 | BetaToolComputerUse20250124`. `computeAnthropicBetas()` adds headers for files, interleaved thinking, context management, MCP and code execution, not computer use (a caller could pass `request.headers`). `model-meta.ts` leaves `computer_use` off claude-opus-5-5, claude-sonnet-5-5 and claude-haiku-5-5 with the comment "this model accepts only `computer_toolset_20260801`, and `computerUseTool()` sends the older versions, which return a 400." No `toolset` handling exists in the adapter source (`grep toolset` finds only an MCP comment), so neither the computer nor the browser toolset's `toolset_name` round-trip is supported.
- **OpenAI provider tool** [T2]. `convertComputerUseToolToAdapterFormat()` emits `{ type: "computer_use_preview", display_height, display_width, environment }`. `responses-text.ts` handles `message`, `reasoning`, `function_call`, `web_search_call` and `shell_call` output items; `computer_call` appears nowhere in the adapter source.
- **Provider tools without `execute`** go down the client-tool path in the chat loop (`!tool.execute` adds a client request) [T3].
- **Custom tools** [T3]. `toolDefinition({...}).server(execute)` is how this repo defines tools (`artifact-tool.ts`, `fetch-url-tool.ts`). `normalizeToolResult()` passes a string or a `ContentPart[]` through unchanged and `JSON.stringify`s anything else. The Anthropic adapter maps a `ContentPart[]` tool message into `tool_result.content` parts, so a Playwright screenshot can return as an image part. Whether the OpenAI Responses adapter carries image parts into `function_call_output` was not checked.

## Token cost per step

Per-step cost = (request overhead) + (new observation) + (whole prior history, which is resent each request). Figures below are for the observation and the fixed overhead.

| Item                                                             | Tokens                                                                                                      | Source   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| Anthropic `computer_toolset_20260801` definition + system prompt | ~4,500 per request (~4,590 Sonnet 5, ~4,520 others); disabling `zoom` saves ~410                            | [A1]     |
| Anthropic `computer_20251124` / `computer_20250124`              | 466–499 system prompt + ~735 tool definition                                                                | [A1]     |
| Anthropic screenshot, 1280×800, toolset-era models               | ⌈1280/28⌉ × ⌈800/28⌉ = 46 × 29 = **1,334** (docs: "roughly 1,000–1,800" per screenshot)                     | [A1]     |
| OpenAI screenshot, 1280×800, patch models (multiplier 1.2)       | ⌈1280/32⌉ × ⌈800/32⌉ = 1,000 patches × 1.2 = **1,200**; 1440×900 = 1,305 × 1.2 = 1,566                      | [O3]     |
| OpenAI computer tool definition overhead                         | Not published on the pages read                                                                             | [O1]     |
| Accessibility tree read (Playwright / Anthropic `read_page`)     | Page-dependent; `read_page` capped at 50,000 characters; "often costs fewer input tokens than a screenshot" | [A2]     |
| browser-use step                                                 | Indexed DOM text plus a screenshot by default (`use_vision=True`); no per-step figure published             | [B2][B5] |
| Stagehand `act` replay of an observed action                     | 0 model tokens ("No LLM call")                                                                              | [S4]     |

Notes: the OpenAI multiplier table [O3] does not list `gpt-6.1-sol`, the model in the computer-use examples, so its multiplier is unconfirmed. Anthropic requests with more than 20 images get a 2000 px per-side limit [A1]. The lecture's answer to screenshot build-up is a separate computer-use helper agent, so screenshots stay out of the main agent's context (slide 26 subtitle, slide 27).

## Sources

- [A1] Anthropic, Computer use tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- [A2] Anthropic, Browser use tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
- [O1] OpenAI, Computer use: https://developers.openai.com/api/docs/guides/tools-computer-use
- [O2] OpenAI, Computer use integration (migration, confirmation and consent): https://developers.openai.com/api/docs/guides/tools-computer-use-integration
- [O3] OpenAI, Images and vision (patch tokenization): https://developers.openai.com/api/docs/guides/images-vision
- [P1] Playwright, Aria snapshots: https://playwright.dev/docs/aria-snapshots
- [P2] Playwright, `locator.ariaSnapshot`: https://playwright.dev/docs/api/class-locator#locator-aria-snapshot
- [P3] Playwright, Release notes (1.49, 1.59–1.64): https://playwright.dev/docs/release-notes
- [S1] Stagehand repo README: https://github.com/browserbase/stagehand
- [S2] Stagehand docs home (v4): https://docs.stagehand.dev/
- [S3] Stagehand agent (v3): https://docs.stagehand.dev/v3/basics/agent.md
- [S4] Stagehand observe (v4): https://docs.stagehand.dev/v4/basics/observe.md
- [S5] Stagehand Claude toolset quickstart: https://docs.stagehand.dev/v4/integrations/agent-frameworks/claude-cua-toolset-quickstart.md
- [B1] browser-use repo README: https://github.com/browser-use/browser-use
- [B2] browser-use system prompt: https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/agent/system_prompts/system_prompt.md
- [B3] browser-use open-source quickstart: https://docs.browser-use.com/open-source/quickstart
- [B4] Browser Use Cloud quickstart: https://docs.browser-use.com/
- [B5] browser-use agent parameters: https://docs.browser-use.com/open-source/customize/agent/all-parameters.md
- [T1] `@tanstack/ai-anthropic@0.20.0` source in `node_modules`: `src/tools/computer-use-tool.ts`, `src/adapters/text.ts` (`computeAnthropicBetas`, tool_result mapping), `src/model-meta.ts`
- [T2] `@tanstack/openai-base@0.12.6` source: `src/tools/computer-use-tool.ts`, `src/adapters/responses-text.ts`
- [T3] `@tanstack/ai@0.66.0` source: `src/activities/chat/index.ts` (client and approval requests), `src/utilities/tool-result.ts` (`normalizeToolResult`), `src/tools/provider-tool.ts`
- Lecture write-up: first comment on [#383](https://github.com/Daanish2003/ai-chat/issues/383), slides 26–27
