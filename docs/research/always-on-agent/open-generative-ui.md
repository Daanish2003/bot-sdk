# Open generative-UI standards

Research for [#405](https://github.com/Daanish2003/ai-chat/issues/405) (child of map [#383](https://github.com/Daanish2003/ai-chat/issues/383)). Researched 2026-10-16. It feeds [#406](https://github.com/Daanish2003/ai-chat/issues/406), "Rich SendToUser messages as an open UI format".

## Question

What open, schema-based formats let an agent send rich UI that each client renders with its own components? For each format: the message schema (components, actions, form input), how actions get back to the agent, streaming, security, TypeScript and React support, fit with TanStack AI, licence and maturity, and whether a Host can map it onto its own design system and onto non-visual channels (email, Slack).

The lecture's slide 23, "Pairing tools with the right UI", shows the target: a payment approval card with Allow and Deny, an email draft card with Send and Discard, a sign-in card, and an emoji reaction. Each is "a purpose-built control" that a tool shows when the user must see or approve something.

**Facts only. This file makes no pick.**

## Summary

There are two families, plus a transport that carries both.

- **Declarative (data, not code).** The agent sends JSON or a small DSL that names components from a catalog the client owns. The client renders with its own components. Thesys **OpenUI Lang**, Vercel **json-render**, Google **A2UI**, and (older) Microsoft **Adaptive Cards** are in this family.
- **Open-ended (code in a sandbox).** The agent or an MCP server sends HTML, CSS and JS that run in a sandboxed iframe. **MCP Apps** (the MCP extension standardised from **MCP-UI**) and CopilotKit's **Open Generative UI** are in this family. The Host's design system reaches the UI only through theme CSS variables.
- **Transport.** **AG-UI** is not a UI format. It is the agent-to-app event protocol. AG-UI's own docs say "AG-UI is not a generative UI specification" ([AG-UI docs][agui-genui]). TanStack AI's stream chunks are AG-UI events (see [Fit with TanStack AI](#fit-with-tanstack-ai)).

| Format                                    | Kind                               | Payload                                                                                                                | Action back to agent                                                                                                                                     | Streaming                                                                                    | Code runs?                                                                                    | React                                                                                                       | Non-web outputs (first-party)                                                   | Licence                                   | Maturity (2026-10-16)                                                                  |
| ----------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| **OpenUI Lang** (Thesys)                  | Declarative DSL                    | Line-based `id = Component(args)` text, components defined with Zod                                                    | `@ToAssistant(msg, context)` emits a `continue_conversation` event; `Query`/`Mutation` call Host tools directly, without the model                       | Yes, line by line; invalid lines dropped                                                     | No; only registered components, functions and actions                                         | `@openuidev/react-lang` 1.0.1, plus Vue, Svelte, Angular                                                    | `@openuidev/react-email` 0.4.0                                                  | MIT                                       | Lang spec 1.0; 11.2k stars; repo since 2024-12                                         |
| **json-render** (Vercel Labs)             | Declarative JSON                   | Flat spec `{ root, elements: { id: { type, props, children } } }`, Zod catalog                                         | Catalog `actions` run by Host-supplied `handlers`; the Host decides whether a handler messages the agent                                                 | Yes, SpecStream: JSONL of RFC 6902 JSON Patch ops                                            | No; registered components, actions and `$computed` functions only                             | `@json-render/react` 0.21.1; `@json-render/shadcn` (36 shadcn/ui components); `@json-render/tanstack-start` | `react-email`, `react-pdf`, `ink` (terminal), `image`, `remotion`, React Native | Apache-2.0                                | 0.x; 18.7k stars; repo since 2026-01                                                   |
| **A2UI** (Google, `a2ui-project`)         | Declarative JSON (JSONL envelopes) | `createSurface`, `updateComponents` (flat adjacency list), `updateDataModel`, `deleteSurface`                          | Client sends an `action` message `{ name, surfaceId, sourceComponentId, timestamp, context }`; input bound to the data model and resolved into `context` | Yes, ordered JSONL message stream; incremental component and data updates                    | No; catalog components and registered functions only                                          | `@a2ui/react` 0.13.0 (v0.9.1 stable), Lit, Angular, Flutter                                                 | None first-party (Flutter, Jetpack Compose alpha)                               | Apache-2.0                                | v0.9.1 production, v1.0 release candidate, "Early stage public preview"; 16.7k stars   |
| **MCP Apps** (MCP extension, SEP-1865)    | Open-ended (HTML in iframe)        | `ui://` resource, `text/html;profile=mcp-app`, linked from a tool's `_meta.ui.resourceUri`                             | View calls `tools/call` through the Host, or `ui/message` (adds a chat message, triggers a follow-up), or `ui/update-model-context`                      | Tool arguments streamed to the View as `ui/notifications/tool-input-partial`                 | Yes, the server's HTML and JS, in a sandboxed iframe behind a separate-origin proxy, with CSP | `@modelcontextprotocol/ext-apps/react` 2.0.3 (View side); `@mcp-ui/client` 7.1.1 `AppRenderer` (Host side)  | None; tool result's text `content` is the fallback                              | Apache-2.0 (MIT for legacy contributions) | Spec 2026-01-26 "Stable"; supported by ChatGPT, Claude, VS Code, Goose and others      |
| **MCP-UI**                                | Open-ended (HTML, URL, Remote DOM) | `UIResource` embedded in a tool result                                                                                 | `onUIAction`: `tool`, `prompt`, `link`, `notify`, `intent`                                                                                               | n/a                                                                                          | Yes, in an iframe                                                                             | `@mcp-ui/client`                                                                                            | None                                                                            | Apache-2.0                                | Now "legacy MCP-UI hosts"; the project points to MCP Apps                              |
| **Open Generative UI** (CopilotKit)       | Open-ended (HTML/CSS/JS in iframe) | `generateSandboxedUi` tool args: `initialHeight`, `placeholderMessages`, `css`, `html`, `jsFunctions`, `jsExpressions` | Sandbox calls `sendPrompt({ text })`, which starts a new agent turn; `openLink({ url })`                                                                 | Yes, ordered fields stream into a preview iframe as an AG-UI activity (`open-generative-ui`) | Yes, model-written JS, in a Websandbox iframe with no same-origin access                      | `@copilotkit/react-core` 1.79.1 (`OpenGenerativeUIRenderer`)                                                | None                                                                            | MIT                                       | Feature of CopilotKit; showcase app renamed to `OpenIntelligentUI`; no standalone spec |
| **Open-JSON-UI** (OpenAI, per CopilotKit) | Declarative JSON                   | Not verified                                                                                                           | Not verified                                                                                                                                             | Not verified                                                                                 | Not verified                                                                                  | CopilotKit only                                                                                             | Not verified                                                                    | Not verified                              | **No primary OpenAI source found**; only CopilotKit and AG-UI docs describe it         |
| **Adaptive Cards** (Microsoft)            | Declarative JSON                   | `body` elements and an `actions` array                                                                                 | Not researched                                                                                                                                           | Not researched                                                                               | No                                                                                            | Not researched                                                                                              | Not researched                                                                  | MIT                                       | Repo active (pushed 2026-10-06); listed for completeness                               |

## Per format

### OpenUI (Thesys) — OpenUI Lang

Repo [`thesysdev/openui`][openui-repo], MIT, 11.2k stars, created 2024-12-02, pushed 2026-10-15. Describes itself as "The Open Standard for Generative UI".

- **Schema.** A program is one `identifier = Expression` statement per line; the entry is the statement named `root`. Positional arguments map to props by Zod key order. Statement kinds are components or values, `$variable` declarations, and `Query`/`Mutation` statements ([spec 1.0][openui-spec]). Components are defined with `defineComponent({ name, description, props: z.object(...), component })` and gathered with `createLibrary`. The system prompt is generated from the library ([README][openui-repo]).
- **Actions and forms.** Built-ins: `@ToAssistant(message, context?)`, `@OpenUrl`, `@Set`, `@Reset`, `@Run`, and custom `@Name` actions defined with `defineAction`. "The renderer runs `@Set`, `@Reset`, and `@Run` itself. `@ToAssistant`, `@OpenUrl`, and custom actions reach your app as events." A `@ToAssistant` event carries `humanFriendlyMessage`, `params.context` and `formState` ([actions][openui-actions]).
- **Round trip.** "The host decides how the context reaches the model" ([actions][openui-actions]). Separately, `Query("tool", args, default)` and `Mutation` call tools from the Host's `toolProvider`: "The runtime calls your tools directly, without the model" ([queries and mutations][openui-qm]).
- **Streaming.** "The renderer can show each line as it arrives from the model … The parser validates the output, drops the invalid parts, and the renderer shows the rest" ([openui.com][openui-lang]). The README claims up to 67% fewer tokens than JSON, measured by Thesys against json-render and its own C1 JSON ([README benchmarks][openui-repo]).
- **Security.** "Restrict output to the components you define and register" ([README][openui-repo]). No arbitrary code; actions and functions must be registered.
- **TS/React.** `@openuidev/react-lang` 1.0.1 (npm), `react-headless`, `react-ui`, plus Vue, Svelte and Angular runtimes, and `@openuidev/a2ui` (an A2UI v1.0 client with OpenUI Lang payloads).
- **Design system.** Bring-your-own components; the repo has a `docs/.../examples/design-systems/shadcn.mdx` example.
- **Non-visual.** `@openuidev/react-email` "React Email component definitions plus prompt options for model-generated emails". No Slack renderer found.
- **Integrations.** `@openuidev/langchain` streams "OpenUI through AG-UI"; a Vercel AI SDK example exists. No TanStack AI integration found. Because OpenUI Lang is plain text, it rides in an ordinary text stream.

### json-render (Vercel Labs)

Repo [`vercel-labs/json-render`][jr-repo], Apache-2.0, 18.7k stars, created 2026-01-14. `@json-render/core` 0.21.1.

- **Schema.** `defineCatalog(schema, { components: { Name: { props: z.object(...), description } }, actions: { name: { description } } })`. A spec is flat: `{ root: "card-1", elements: { "card-1": { type, props, children: [ids] } } }`. Props can be expressions: `$state`, `$cond/$then/$else`, `$template`, `$computed` (calls a registered function). Elements have `visible` conditions and `watch` (fire an action when state changes) ([README][jr-repo]).
- **Actions and forms.** Components call `emit("press")`; props name an action, such as the built-in `setState`. Inputs bind with `{ "$bindState": "/form/country" }`. Catalog actions are run by `handlers` the Host passes to `JSONUIProvider` ([README][jr-repo]). There is no built-in "send to agent" action; a handler decides.
- **Streaming.** SpecStream: "a JSONL-based streaming format where each line is a JSON patch operation" (RFC 6902), compiled with `createSpecStreamCompiler` ([streaming][jr-stream]).
- **Security.** "AI can only use components in your catalog" ([README][jr-repo]).
- **TS/React.** React, Vue, Svelte, Solid, React Native. `@json-render/shadcn` ships 36 shadcn/ui components. `@json-render/tanstack-start` renders full TanStack Start apps from specs.
- **Non-visual.** First-party renderers for React Email (HTML and plain-text email), React PDF, Ink (terminal), Satori images and Remotion video. No Slack renderer found.
- **Other standards.** Docs pages show json-render rendering A2UI, Adaptive Cards and AG-UI; each is marked "Concept … illustrative and may require adaptation" ([a2ui][jr-a2ui], [ag-ui][jr-agui]). `@json-render/mcp` targets MCP Apps.

### A2UI (Google, now `a2ui-project`)

Repo [`a2ui-project/a2ui`][a2ui-repo] (moved from `google/A2UI`), Apache-2.0, 16.7k stars, created 2025-09-24. Status: "Early stage public preview … current production release is v0.9.1 … The v1.0 specification is a release candidate" ([README][a2ui-repo]; [v1.0 README][a2ui-v1]).

- **Schema.** A one-way server-to-client JSON message stream with four envelopes: `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`. Components are a flat adjacency list with ID references ([protocol v0.9.1][a2ui-proto]). The basic catalog has Text, Image, Icon, Video, AudioPlayer, Row, Column, List, Card, Tabs, Divider, Modal, Button, CheckBox, TextField, DateTimeInput, ChoicePicker and Slider, plus validation functions (`required`, `regex`, `length`, `numeric`, `email`).
- **Actions and forms.** A component's `action` is either `event: { name, context }` (sent to the server) or `functionCall` (a local registered function). Two-way binding "is local to the client"; on a button click the `context` resolves bound paths such as `{ "path": "/formData/email" }`. The client sends an `action` message with `name`, `surfaceId`, `sourceComponentId`, `timestamp`, `context` ([protocol][a2ui-proto]).
- **Transport.** Transport-agnostic; requires ordered delivery and message framing. Bindings for A2A and AG-UI; MCP, SSE, WebSockets and REST also listed ([protocol][a2ui-proto]).
- **Security.** "A2UI is a declarative data format, not executable code … the agent can only request to render components from that catalog" ([README][a2ui-repo]).
- **TS/React.** React renderer stable for v0.8 and v0.9.1, v1.0 planned; also Lit, Angular, Flutter (GenUI SDK), Jetpack Compose alpha ([renderers][a2ui-renderers]). `@a2ui/react` 0.13.0 on npm.
- **Design system.** "Your client application is responsible for mapping these abstract descriptions to its native widgets" ([README][a2ui-repo]). Clients advertise `supportedCatalogIds` and can send `inlineCatalogs`.
- **Non-visual.** No first-party email or Slack renderer. AG-UI's CLI scaffolds Slack and Teams harnesses that "enable A2UI rendering over AG-UI" ([README][a2ui-repo]); how A2UI maps into Slack there was not verified.

### MCP Apps (MCP extension) and MCP-UI

Repo [`modelcontextprotocol/ext-apps`][extapps-repo]. Licence: Apache-2.0 for new contributions, MIT for unrelicensed older ones (repo `LICENSE`). Spec version 2026-01-26 is "Stable" ([spec][extapps-spec]). `@modelcontextprotocol/ext-apps` 2.0.3 (2026-09-25). Supported clients listed: ChatGPT, Claude, VS Code, Goose, Postman, MCPJam and others ([README][extapps-repo]).

- **Schema.** A tool declares `_meta.ui.resourceUri` pointing to a `ui://` resource. Content "MUST be `text/html;profile=mcp-app`" and a valid HTML5 document. Tool `visibility: ["model", "app"]`; app-only tools are hidden from the model but callable by the View ([spec][extapps-spec]).
- **Round trip.** The View talks JSON-RPC over `postMessage`: `ui/initialize`, `tools/call` (proxied by the Host, which "MAY decide to block some messages or subject them to further user approval"), `ui/message` ("Send message content to the host's chat interface", which triggers a follow-up), `ui/update-model-context`, `ui/open-link`, `ui/request-display-mode`. The Host sends `ui/notifications/tool-input`, `tool-result`, `tool-cancelled`, `host-context-changed` ([spec][extapps-spec]).
- **Streaming.** "Host MAY send [`ui/notifications/tool-input-partial`] zero or more times while the agent is streaming tool arguments" ([spec][extapps-spec]).
- **Security.** A web Host "MUST wrap the View … through an intermediate Sandbox proxy" on a different origin; CSP built from declared `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`; a restrictive default (`default-src 'none'; connect-src 'none'`); `object-src 'none'` ([spec][extapps-spec]). The View's code is arbitrary HTML and JS, isolated by the sandbox.
- **Design system.** The Host passes `hostContext.theme` and standard CSS variables (`--color-background-primary`, `--color-text-primary`, and so on) ([spec][extapps-spec]). The View's own components render; the Host's React components do not.
- **Non-visual.** None. A tool result still carries text `content` for hosts without UI.
- **MCP-UI.** [`MCP-UI-Org/mcp-ui`][mcpui-repo], Apache-2.0. "The patterns developed here directly influenced the MCP Apps specification". `@mcp-ui/client` (7.1.1) offers `AppRenderer` for MCP Apps and `UIResourceRenderer` for "legacy MCP-UI hosts", whose `onUIAction` handles `tool`, `prompt`, `link`, `notify` and `intent` actions ([README][mcpui-repo]).

### CopilotKit Open Generative UI and AG-UI

**AG-UI** ([`ag-ui-protocol/ag-ui`][agui-repo], MIT, 16.6k stars): "an open, lightweight, event-based protocol" with about 16 standard event types, over any transport (SSE, WebSockets, webhooks). It lists bi-directional state sync, generative UI, frontend tools and human-in-the-loop. AG-UI says it "natively supports" A2UI, Open-JSON-UI and MCP-UI ([generative-UI specs][agui-genui]). `@ag-ui/core` 1.0.3. Middleware packages exist on npm: `@ag-ui/a2ui-middleware` 0.0.12 and `@ag-ui/mcp-apps-middleware` 0.1.2.

**Open Generative UI** is a CopilotKit runtime feature, not a separate spec. Showcase repo [`CopilotKit/OpenIntelligentUI`][oiui-repo] (MIT; GitHub redirects `CopilotKit/OpenGenerativeUI` to it).

- **Schema.** The `generateSandboxedUi` tool takes ordered fields `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions`. Middleware turns it into AG-UI activity messages with `activityType: "open-generative-ui"` ([architecture][oiui-arch]; `OpenGenerativeUIRenderer.tsx` in [CopilotKit][ck-renderer]).
- **Round trip.** "The host exposes validated `sendPrompt({ text })` and HTTPS `openLink({ url })` callbacks". "A follow-up starts a new agent turn … arbitrary iframe control state is not automatically synchronized to the agent" ([architecture][oiui-arch]).
- **Streaming.** "The renderer holds the placeholder until CSS is complete, progressively updates a preview iframe, then initializes the final Websandbox iframe" ([architecture][oiui-arch]).
- **Security.** Model-written JS runs in a sandbox with "no same-origin access to storage or host APIs" ([architecture][oiui-arch]).
- **Design system.** Shared theme CSS is injected; components are not the Host's.
- **Non-visual.** None.
- **Same app, two formats.** The showcase routes "basic tables" to A2UI and "charts, diagrams, calculators, and maps" to Open Generative UI ([README][oiui-repo]).

### Others found

- **Open-JSON-UI.** CopilotKit and AG-UI docs call it "an open standardization of OpenAI's internal declarative Generative UI schema" ([CopilotKit snippet][ck-specs]). No OpenAI-published spec or repo was found, so its schema is not verified here.
- **Adaptive Cards** ([`microsoft/AdaptiveCards`][ac-repo], MIT). A JSON card format with a `body` of elements and an `actions` array. It predates LLM generative UI and was not researched in depth here. json-render documents rendering it ([adaptive-cards][jr-repo-docs]).
- **OpenAI Apps SDK.** ChatGPT is listed as an MCP Apps client, and ext-apps ships a `migrate-oai-app` skill that "Converts an existing OpenAI App to use MCP Apps" ([README][extapps-repo]).

## Fit with TanStack AI

Read from the installed packages in `packages/chat-sdk` (`@tanstack/ai` 0.66.0, `@tanstack/ai-react` 0.30.1, `@tanstack/ai-mcp` 0.8.1).

- **TanStack AI speaks AG-UI.** `@tanstack/ai` depends on `@ag-ui/core` 1.0.0. Its stream-chunk types extend AG-UI events (`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT/DELTA`, `ACTIVITY_SNAPSHOT/DELTA`, `CUSTOM`, and others) and it re-exports `EventType` from `@ag-ui/core` (`dist/esm/types.d.ts`).
- **Activity parts.** `UIMessage` has an `ActivityPart` (`type: 'activity'`, `activityType`, `content`) from AG-UI's `ActivityMessage`, and `ActivityDeltaEvent` is "RFC 6902 JSON Patch against an existing activity's `content`". `ActivityRecord` is a "durable sidecar row for frontend-only AG-UI activity. Never a ModelMessage." This is the slot that CopilotKit uses for Open Generative UI and that an A2UI or json-render payload could occupy. No TanStack renderer for A2UI, OpenUI or json-render was found.
- **MCP Apps is built in.** `@tanstack/ai` has a `UIResourcePart` (`type: 'ui-resource'`, `resource: { uri, mimeType, text?, blob? }`, `serverId`, `toolCallId`, `toolName`). `@tanstack/ai-react` exports `MCPAppResource`, which wraps `AppRenderer` from `@mcp-ui/client` (a `^7` peer dependency, not installed in this repo) and takes a `sandbox: { url }` proxy page and an optional `McpAppBridge`. `@tanstack/ai-mcp/apps` exports `createMcpAppCallHandler` (serves widget `tools/call`, with an `allowTool` authorizer and the same `needsApproval` the model gets) and `inMemoryMcpSessionStore`. `extractUiResourceUri` reads `_meta.ui.resourceUri`.
- **Plain text or tool args.** OpenUI Lang streams as ordinary text. json-render and A2UI payloads can travel as tool-call arguments or structured output, which TanStack already streams.

## Design system and non-visual channels

| Format             | Host's own components (e.g. shadcn in `packages/ui`)                | Email                                    | Slack                           |
| ------------------ | ------------------------------------------------------------------- | ---------------------------------------- | ------------------------------- |
| OpenUI Lang        | Yes, the Host defines the library; shadcn example in docs           | `@openuidev/react-email`                 | None found                      |
| json-render        | Yes, the Host's registry; `@json-render/shadcn` ships 36 components | `@json-render/react-email` (HTML + text) | None found                      |
| A2UI               | Yes, the Host maps catalog types to its widgets                     | None first-party                         | Via AG-UI harness, not verified |
| MCP Apps / MCP-UI  | No; the server's HTML renders. Theme via CSS variables only         | No; text `content` fallback              | No                              |
| Open Generative UI | No; model-written HTML. Shared theme CSS injected                   | No                                       | No                              |
| Adaptive Cards     | Not researched                                                      | Not researched                           | Not researched                  |

## Sources

- [openui-repo]: https://github.com/thesysdev/openui "README, read via `gh api` 2026-10-16"
- [openui-spec]: https://github.com/thesysdev/openui/blob/main/docs/content/docs/openui-lang/specification/index.mdx
- [openui-actions]: https://github.com/thesysdev/openui/blob/main/docs/content/docs/openui-lang/actions.mdx
- [openui-qm]: https://github.com/thesysdev/openui/blob/main/docs/content/docs/openui-lang/queries-mutations.mdx
- [openui-lang]: https://www.openui.com/docs/openui-lang
- [jr-repo]: https://github.com/vercel-labs/json-render "README"
- [jr-stream]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/streaming.mdx
- [jr-a2ui]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/a2ui.mdx
- [jr-agui]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/ag-ui.mdx
- [jr-repo-docs]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/adaptive-cards.mdx
- [a2ui-repo]: https://github.com/a2ui-project/a2ui "README"
- [a2ui-proto]: https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9_1/docs/a2ui_protocol.md
- [a2ui-v1]: https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/README.md
- [a2ui-renderers]: https://github.com/a2ui-project/a2ui/blob/main/docs/public/reference/renderers.md
- [extapps-repo]: https://github.com/modelcontextprotocol/ext-apps "README, LICENSE"
- [extapps-spec]: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- [mcpui-repo]: https://github.com/MCP-UI-Org/mcp-ui "README"
- [agui-repo]: https://github.com/ag-ui-protocol/ag-ui "README"
- [agui-genui]: https://docs.ag-ui.com/concepts/generative-ui-specs
- [oiui-repo]: https://github.com/CopilotKit/OpenIntelligentUI "README"
- [oiui-arch]: https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/architecture.md
- [ck-renderer]: https://github.com/CopilotKit/CopilotKit/blob/main/packages/react-core/src/v2/components/OpenGenerativeUIRenderer.tsx
- [ck-specs]: https://github.com/CopilotKit/CopilotKit/blob/main/showcase/shell-docs/src/content/snippets/shared/generative-ui-specs-overview.mdx
- [ac-repo]: https://github.com/microsoft/AdaptiveCards
- npm versions from `pnpm view` on 2026-10-16: `@openuidev/react-lang` 1.0.1, `@openuidev/react-email` 0.4.0, `@json-render/core` 0.21.1, `@a2ui/react` 0.13.0, `@ag-ui/core` 1.0.3, `@mcp-ui/client` 7.1.1, `@modelcontextprotocol/ext-apps` 2.0.3, `@copilotkit/react-core` 1.79.1.
- Repo stars, licences and dates from the GitHub API on 2026-10-16.
- TanStack AI facts from `packages/chat-sdk/node_modules/@tanstack/{ai,ai-react,ai-mcp}` type declarations.

[openui-repo]: https://github.com/thesysdev/openui
[openui-spec]: https://github.com/thesysdev/openui/blob/main/docs/content/docs/openui-lang/specification/index.mdx
[openui-actions]: https://github.com/thesysdev/openui/blob/main/docs/content/docs/openui-lang/actions.mdx
[openui-qm]: https://github.com/thesysdev/openui/blob/main/docs/content/docs/openui-lang/queries-mutations.mdx
[openui-lang]: https://www.openui.com/docs/openui-lang
[jr-repo]: https://github.com/vercel-labs/json-render
[jr-stream]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/streaming.mdx
[jr-a2ui]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/a2ui.mdx
[jr-agui]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/ag-ui.mdx
[jr-repo-docs]: https://github.com/vercel-labs/json-render/blob/main/apps/web/content/docs/adaptive-cards.mdx
[a2ui-repo]: https://github.com/a2ui-project/a2ui
[a2ui-proto]: https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9_1/docs/a2ui_protocol.md
[a2ui-v1]: https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/README.md
[a2ui-renderers]: https://github.com/a2ui-project/a2ui/blob/main/docs/public/reference/renderers.md
[extapps-repo]: https://github.com/modelcontextprotocol/ext-apps
[extapps-spec]: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
[mcpui-repo]: https://github.com/MCP-UI-Org/mcp-ui
[agui-repo]: https://github.com/ag-ui-protocol/ag-ui
[agui-genui]: https://docs.ag-ui.com/concepts/generative-ui-specs
[oiui-repo]: https://github.com/CopilotKit/OpenIntelligentUI
[oiui-arch]: https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/architecture.md
[ck-renderer]: https://github.com/CopilotKit/CopilotKit/blob/main/packages/react-core/src/v2/components/OpenGenerativeUIRenderer.tsx
[ck-specs]: https://github.com/CopilotKit/CopilotKit/blob/main/showcase/shell-docs/src/content/snippets/shared/generative-ui-specs-overview.mdx
[ac-repo]: https://github.com/microsoft/AdaptiveCards
