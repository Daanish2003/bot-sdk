# Telling read-only Connector tools apart

Research for [#1015](https://github.com/Daanish2003/bot-sdk/issues/1015) (child of map [#975](https://github.com/Daanish2003/bot-sdk/issues/975), "Proactive defaults"). Researched 2026-10-30.

## Question

Can the Bot SDK tell a Connector tool that only reads from one that changes something, reliably enough to give a proactive Turn read-only Connector tools? Look at MCP tool annotations (`readOnlyHint`, `destructiveHint`), how widely real MCP servers set them, what the MCP spec says about trusting them, and how ChatGPT dots limits proactive research to reading.

Owner decision already made: a Turn the user didn't start is read-only for Connections. Write tools are removed from it, not left to Auto-review.

## Answer

**Yes, but only because the Host already vouches for every server. The annotation is a default that the Host can override, not the source of truth.**

1. **The spec gives us the signal and tells us when we may use it.** `ToolAnnotations.readOnlyHint` means "the tool does not modify its environment", and it defaults to `false` [M1]. The spec also says clients "**MUST** consider tool annotations to be untrusted unless they come from trusted servers" [M2], and "should never make tool use decisions based on `ToolAnnotations` received from untrusted servers" [M1]. Our servers aren't untrusted in that sense. A Host lists every MCP server it offers (`McpServerConfig`, [`servers.ts`](../../packages/botsdk/mcp/src/server/servers.ts)), and users can't add their own. That makes the Host the party that decides trust.
2. **Fail closed.** A tool counts as read-only only when its server says `readOnlyHint: true` explicitly, or the Host lists it as read-only. A missing annotation stays at the spec default (`false`), so the tool is removed. That direction can only cost a proactive Turn a tool it could have used. It can't hand the Turn a write.
3. **The Host gets the last word, per server.** The annotation can be wrong both ways. Notion's open-source server marks every non-GET endpoint `destructiveHint: true`, so its POST search would be dropped [S3]. A server could also claim read-only and write anyway [B1]. The Host needs a per-server override (a read-only tool-name list, or "don't trust this server's annotations"), next to the `tools` and `approvalFree` lists it already sets.
4. **Removing beats reviewing.** The MCP blog says a `readOnlyHint` from an untrusted server "isn't actionable" and that real guarantees belong in "deterministic controls" [B1]. Taking write tools out of the proactive Turn's tool list is a deterministic control. Auto-review isn't one.

## What the MCP spec says

Read at `modelcontextprotocol/modelcontextprotocol@84d8457` (2026-10-29), spec version `2026-07-28`.

| Hint              | Meaning                                                                                                                                | Default | Source |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| `readOnlyHint`    | "If true, the tool does not modify its environment."                                                                                   | `false` | [M1]   |
| `destructiveHint` | "If true, the tool may perform destructive updates … If false, … only additive updates." Only meaningful when `readOnlyHint == false`. | `true`  | [M1]   |
| `idempotentHint`  | Repeated calls with the same arguments have no extra effect. Only meaningful when `readOnlyHint == false`.                             | `false` | [M1]   |
| `openWorldHint`   | The tool may reach an "open world" of external entities (web search: open; memory: closed).                                            | `true`  | [M1]   |

- `destructiveHint` is no help here. It only separates additive writes from destructive ones, and a proactive Turn wants neither. The only question that matters is `readOnlyHint === true`.
- On trust, the schema says "all properties in `ToolAnnotations` are **hints**. They are not guaranteed to provide a faithful description of tool behavior" and "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers" [M1]. The tools page says clients **MUST** treat annotations as untrusted "unless they come from trusted servers" [M2]. The overview says the same about descriptions of tool behaviour "such as annotations" [M3].
- The spec does not define what makes a server "trusted". The MCP blog says "most clients still treat installation itself as the trust signal" [B1]. A Host listing the server in `mcp({ servers })` is our equivalent of installing it.
- Annotations come from each `tools/list` call, so a server can change them between Turns. The filter has to run every time tools are opened (`openMcpTools` already runs per Turn), not once when the Connection is made.

### Where the spec is heading

- **SEP-1913, "Trust and Sensitivity Annotations"**, is still `draft` and open (last updated 2026-10-16) [M4]. The MCP blog says GitHub and OpenAI co-wrote it [B1]. Nothing in it is usable yet.
- The blog lists other proposals: `trustedHint` (#1487), `secretHint` (#1560) and `unsafeOutputHint` (#1561). It also mentions a forming Tool Annotations Interest Group and a host-side idea of marking a session "tainted" once an untrusted-content tool runs [B1].

## How widely real servers set them

| Server                                                   | Sets `readOnlyHint`?                                                                                                                                                                                                                                                                                                                                                             | Source                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| GitHub (`github/github-mcp-server`)                      | Yes, on every tool, and a test enforces it. `pkg/toolvalidation/readonlyhint.go` fails any `mcp.Tool` that doesn't set `ReadOnlyHint` explicitly, because a silent `false` "has triggered downstream agents to prompt for human approval on safe read operations". It also ships a `--read-only` mode that "will only offer read-only tools", and that mode wins over `--tools`. | [S1] (`f2a07cd`), README "Read-Only Mode"          |
| Sentry (`getsentry/sentry-mcp`)                          | Yes, all four hints set explicitly. `find-dsns` has `readOnlyHint: true`. `delete-alert-rule` has `readOnlyHint: false, destructiveHint: true`.                                                                                                                                                                                                                                  | [S2] `packages/mcp-core/src/tools/catalog/*.ts`    |
| Notion (`makenotion/notion-mcp-server`, open-source one) | Yes, worked out from the HTTP method: GET gets `readOnlyHint: true`, everything else gets `destructiveHint: true`. That rule is too cautious, because Notion's search and database query are POST endpoints [N1], so they would be dropped as writes.                                                                                                                            | [S3] `src/openapi-mcp-server/mcp/proxy.ts:176-186` |
| MCP reference servers (`modelcontextprotocol/servers`)   | Yes, in `filesystem`, `memory`, `sequentialthinking` and `everything`.                                                                                                                                                                                                                                                                                                           | [S4] GitHub code search, 41 hits                   |
| ChatGPT apps (any server published to ChatGPT)           | **Required.** Each tool must set `readOnlyHint`, `destructiveHint` and `openWorldHint` "to explicit boolean values", and automated review checks them.                                                                                                                                                                                                                           | [O1], [O2]                                         |
| Linear, Atlassian, Slack, Google, other hosted servers   | **Not verified.** Their source is closed, and checking would mean a signed-in `tools/list`. Whatever a Host offers has to be checked server by server.                                                                                                                                                                                                                           | none                                               |

Notes:

- GitHub code search returned 0 hits for `readOnlyHint` in `getsentry/sentry-mcp`, yet the files above set it. Code-search counts are a lower bound and say nothing about servers that didn't turn up.
- The blog's only adoption figure is that GitHub's read-only mode is "enabled by about 17% of users". It also says no MCP client yet lets users filter tools by annotation [B1].
- OpenAI's requirement probably does the most for coverage. A server that also ships as a ChatGPT app has to set all three hints, and they are reviewed. (Inference: we can't see which servers are published there.)

## How ChatGPT dots does it

- From our earlier inventory, which read the Help Center FAQ ([chatgpt-dots-inventory.md](chatgpt-dots-inventory.md) row "Proactivity", source [F]): proactive research "may read sources and save private notes. Its tools can't send messages, change content through plugins, or control a browser or computer. Any follow-up goes through the normal action rules." Search snippets of help article 20001530 [G] say the same: background tasks use "read-only tools on your connected sources". **Not re-read this time:** both Help Center pages returned HTTP 403 to fetches on 2026-10-30.
- OpenAI doesn't say publicly how it decides which plugin tools are read-only. **Unverified inference:** it's most likely the Apps SDK `readOnlyHint`, which is required and reviewed for every published app [O1][O2]. That would be the same as "trusted server + annotation" here, with OpenAI's app review as the trust step.
- OpenAI's own reference says the hints "only influence how ChatGPT or Codex frames the tool call to the user", that servers must still enforce authorization [O1], and that "Annotations inform client safeguards; they do not grant permission or replace authentication" [O2].

## What the repo does today

- Connector tools load in [`packages/botsdk/mcp/src/server/tools.ts`](../../packages/botsdk/mcp/src/server/tools.ts) (`openMcpTools`). It uses `createMCPClient` from `@tanstack/ai-mcp@1.0.0` with `toolFilter` (the Host's `tools` name allowlist) and `needsApproval` (true unless the Host's `approvalFree` lists the tool). [`connector-tools.ts`](../../packages/botsdk/mcp/src/server/connector-tools.ts) turns `needsApproval` into Auto-review.
- **Nothing in `packages/` reads MCP annotations today.** A grep for `readOnlyHint` finds only `node_modules`. The [MCP tools research](mcp-tools.md) recommended "Filter tools by name, never by server-declared annotations", because at that point users might add arbitrary servers. Under the operator-curated model that shipped, the Host fills the trust role.
- The installed library already exposes annotations:
  - `@tanstack/ai-mcp@1.0.0` passes the full MCP `Tool` (with `annotations`) to both `toolFilter` and `needsApproval` (`src/types.ts:196`, `src/tools.ts:28`).
  - Each returned tool carries `metadata.mcp.annotations`, "a frozen copy of the server's `annotations` … All fields are **hints**: useful for display and for shaping an approval UI, never a security boundary" (`src/types.ts:45-50`).
  - Its own harness connector defaults to asking for approval on "every tool the server does not mark `readOnlyHint`" (`src/connector.ts:52-53, 340`).
  - So a read-only filter needs no new dependency. It is a predicate over the `Tool` the filter already receives.
- `approvalFree` and read-only are separate ideas. A Host may make a write tool approval-free, and a read tool may still need review. Don't reuse one list for the other.

## Recommendation for the spec (#1019)

1. In a proactive Turn, `openMcpTools` keeps a Connector tool only if it is read-only by the Host's rule for that server. Every other tool is left out of the tool list, not set to `needsApproval`.
2. Default rule: `tool.annotations?.readOnlyHint === true`. A missing annotation or `false` means the tool is removed.
3. Add a per-server Host override to `McpServerConfig`, for example a `readOnly` tool-name list. When it's set, it replaces the annotation for that server. That covers servers that annotate nothing or annotate wrongly (the Notion POST-search case). The naming and shape are for the spec.
4. Run the check on every `tools/list`, and don't cache it across Turns.
5. Read-only isn't harmless. A read tool with `openWorldHint: true` (a fetch, say) can still leak private data through its arguments: the "lethal trifecta" of private data, untrusted content and outbound communication [B1]. That risk is outside this ticket. Worth mentioning in the spec, not solving here.

## Sources

- **[M1]** MCP schema `ToolAnnotations`, spec `2026-07-28`: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/84d845729393f79b3fd3d392aa17cb86f5b6f95c/schema/2026-07-28/schema.ts (lines ~1901-1954)
- **[M2]** MCP spec, Server → Tools, "annotations": https://github.com/modelcontextprotocol/modelcontextprotocol/blob/84d845729393f79b3fd3d392aa17cb86f5b6f95c/docs/specification/2026-07-28/server/tools.mdx (lines 302-306)
- **[M3]** MCP spec overview, Security and Trust & Safety: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/84d845729393f79b3fd3d392aa17cb86f5b6f95c/docs/specification/2026-07-28/index.mdx (lines 110-111)
- **[M4]** SEP-1913, Trust and Sensitivity Annotations (draft, open): https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1913
- **[B1]** MCP blog, "Tool Annotations as Risk Vocabulary: What Hints Can and Can't Do" (2026-03-16): https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/
- **[S1]** `github/github-mcp-server` @ `f2a07cd`: `pkg/toolvalidation/readonlyhint.go`, README "Read-Only Mode": https://github.com/github/github-mcp-server
- **[S2]** `getsentry/sentry-mcp` main: `packages/mcp-core/src/tools/catalog/find-dsns.ts`, `delete-alert-rule.ts`: https://github.com/getsentry/sentry-mcp
- **[S3]** `makenotion/notion-mcp-server` main: `src/openapi-mcp-server/mcp/proxy.ts`: https://github.com/makenotion/notion-mcp-server
- **[S4]** `modelcontextprotocol/servers` code search for `readOnlyHint`: https://github.com/modelcontextprotocol/servers
- **[N1]** Notion API, "Search" (`POST /v1/search`): https://developers.notion.com/reference/post-search. Not re-fetched; known endpoint method.
- **[O1]** OpenAI Apps SDK reference, tool annotations: https://developers.openai.com/apps-sdk/reference
- **[O2]** OpenAI Apps SDK, app submission guidelines: https://developers.openai.com/apps-sdk/app-submission-guidelines
- **[F]**, **[G]** OpenAI Help Center dots pages, as cited in [chatgpt-dots-inventory.md](chatgpt-dots-inventory.md). They returned 403 on 2026-10-30.
- Installed `@tanstack/ai-mcp@1.0.0` source (`node_modules/.pnpm/@tanstack+ai-mcp@1.0.0_*/node_modules/@tanstack/ai-mcp/src/`).
