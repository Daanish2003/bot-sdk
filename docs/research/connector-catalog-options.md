# Connector catalog options

Research for [#958](https://github.com/Daanish2003/bot-sdk/issues/958) (child of map [#953](https://github.com/Daanish2003/bot-sdk/issues/953)). Researched 2026-10-29.

## Question

How could the Bot reach thousands of Connectors (Claude Duet claims 6,000+) on top of our existing MCP Connections? Compare the official MCP registry, Composio, Pipedream Connect, Smithery and similar: catalog size, auth (remote MCP OAuth, managed OAuth), self-hostability, free tier, TypeScript support.

## What we have today

- `@botsdk/mcp` takes a Host-curated list, `mcp({ servers })`. Each `McpServerConfig` is a remote Streamable HTTP URL (HTTPS only) plus an OAuth client **the Host registered ahead of time**: "no Dynamic Client Registration" ([`packages/botsdk/mcp/src/server/servers.ts`](../../packages/botsdk/mcp/src/server/servers.ts)).
- Sign-in finds the authorize and token endpoints through RFC 9728 and RFC 8414, uses PKCE S256, and makes every request through the guarded `fetch` ([`oauth.ts`](../../packages/botsdk/mcp/src/server/oauth.ts)).
- Connection tokens are encrypted under the keyring, with their own HKDF key, and rotated with `rotateKeys()` ([ADR 0010](../adr/0010-credentials-encrypted-under-a-keyring.md)).
- CONTEXT.md: a **Connection** is "a user's sign-in to one of the MCP servers the Host offers". A **Connector tool** is a Deferred tool, checked by Auto-review.

So the limit today is **one pre-registered OAuth client per server, set up by the Host**. That doesn't scale to thousands. To scale, either the SDK registers itself with each server, or a vendor holds the OAuth apps.

## What Claude Duet actually claims

The product page says "Works with more than 6,000 connectors and plugins", with the connectors and plugins counted together. It says Duet "uses your Claude account, including memory, skills, and connectors" and links to the Claude marketplace. It does not mention MCP or say how connectors authenticate ([claude.com/product/claude-duet](https://claude.com/product/claude-duet)). The 6,000 is a marketplace count, not one integration platform.

## Comparison

| Option                                           | Catalog                                                                                                                              | Auth                                                                                                                                                                    | Self-host                                                                                 | Free tier                                                                                                                   | TypeScript                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Official MCP Registry** (+ our own MCP client) | At least 50,000 entries from `GET /v0/servers?version=latest` (I stopped counting at 50,000); 32,439 of those list a remote URL [R3] | Metadata only. Each server's own OAuth: the client must do CIMD or DCR, or be pre-registered [R4]                                                                       | The API is an open OpenAPI spec, but the codebase is "not designed for self-hosting" [R1] | Free                                                                                                                        | Our existing `@tanstack/ai-mcp` client                |
| **Composio**                                     | "1688 toolkits" [C3]; pricing page says "1500+" [C2]                                                                                 | Managed OAuth by default; your own OAuth app ("custom auth config") recommended for production and required for some toolkits [C4]. Exposes a per-session MCP URL [C1]  | Enterprise only, Helm [C5]                                                                | Hobby $0: 100,000 tool calls and 50,000 triggers a month, unlimited connected accounts [C2]                                 | `@composio/core` [C1]                                 |
| **Pipedream Connect**                            | 3,000+ APIs, 10,000+ tools [P1]                                                                                                      | Managed OAuth; one remote MCP server at `remote.mcp.pipedream.net/v3`, per user through `x-pd-external-user-id`; returns a Connect link when an account is missing [P2] | No (not offered) [P1][P3]                                                                 | Free in development mode only; production needs Startup at $99/month annual or $150/month monthly (100 external users) [P3] | `@pipedream/sdk` [P1]                                 |
| **Smithery**                                     | Registry stays (now run with Arcade)                                                                                                 | Connect, Proxy and managed identity **shut down 2026-10-31** [S1]                                                                                                       | No                                                                                        | Paid plans cancelled and refunded [S1]                                                                                      | SDKs deprecated [S1]                                  |
| **Arcade**                                       | "7,500+ agent-optimized tools across 81 MCP servers" [A1]                                                                            | Managed OAuth and per-user tokens; MCP gateways [A1]                                                                                                                    | Helm self-host [A1]; the pricing page puts VPC and air-gapped under Enterprise [A2]       | $0: 2,000 tool calls a month [A2]                                                                                           | TS guides; no standalone TS SDK on the home page [A1] |
| **Zapier MCP**                                   | "9,000+ apps", 30,000+ actions [Z1]                                                                                                  | Zapier-managed connections, aimed at one Zapier account; the page doesn't cover per-end-user embedding [Z1]                                                             | No                                                                                        | Included in every Zapier plan; 2 tasks per tool call [Z1]                                                                   | n/a (remote MCP)                                      |
| **Nango**                                        | 1,000+ APIs [N1][N2]                                                                                                                 | Managed OAuth, API keys and refresh; MCP is a listed use case [N1]                                                                                                      | Elastic License; "self-host for free with a limited feature set" [N2]                     | Not stated on pages read                                                                                                    | TS functions [N1]                                     |
| **Klavis**                                       | "100+ prebuilt integrations" [K1]                                                                                                    | OAuth support; Strata single-server layer [K1]                                                                                                                          | Apache-2.0; Docker images per server [K1]                                                 | Not stated                                                                                                                  | `KlavisClient` [K1]                                   |
| **Activepieces**                                 | 280+ pieces as MCP [AP1]                                                                                                             | Per-piece connections inside Activepieces                                                                                                                               | MIT Community Edition [AP1]                                                               | Self-hosted free                                                                                                            | Pieces are TS npm packages [AP1]                      |

## Findings per option

### Official MCP Registry plus CIMD (no vendor)

- The registry is "in preview. Breaking changes or data resets may occur". It hosts **metadata** in `server.json`: name, `remotes` or `packages`, description. It is "intended to be consumed primarily by downstream aggregators" and "not intended to be directly consumed by host applications" [R1].
- It does no curation or security scanning. It leaves that to package registries and aggregators [R1]. A catalog built from it would be unvetted by default, which goes against the [mcp-tools research](./mcp-tools.md) advice to start with an operator-curated allowlist.
- What the SDK would have to add: the 2025-11-25 auth spec says clients **SHOULD** support **Client ID Metadata Documents** (an HTTPS URL as `client_id`), **MAY** do DCR, and should try them in this order: pre-registered, then CIMD (if `client_id_metadata_document_supported`), then DCR, then ask the user [R4]. We only do pre-registered. CIMD would let one Host-hosted metadata document sign in to any compliant server without the Host registering anything.
- It also needs RFC 8707 `resource` on the authorize and token requests, and `WWW-Authenticate` / `insufficient_scope` step-up [R4]. Our `oauth.ts` should be checked against both.
- The cost: real coverage is thin. Most SaaS vendors have no first-party remote MCP server with CIMD, and only 5,547 of the registry entries that list a remote declare headers [R3] (a rough signal, not an auth survey).

### Composio

- Largest managed catalog that serves many end users: 1,688 toolkits [C3]. Managed OAuth by default, with sessions created per user (`composio.create("user_123")`) and exposed as an MCP URL plus headers [C1].
- The default OAuth app "shares quota across all users" and shows "Composio" on consent screens. Composio recommends your own app for production [C4].
- The free Hobby tier is generous [C2]. Self-hosting is Enterprise only [C5].

### Pipedream Connect

- 3,000+ APIs behind **one** remote MCP endpoint, scoped per user and per app by headers. The Host authenticates with client-credentials OAuth [P2]. That shape fits our Streamable HTTP client with static headers.
- Free only in development. Real external users need Startup at $99+/month [P3]. Not self-hostable.

### Smithery: ruled out

- "Smithery's connection management services, including the MCP Proxy and managed identity" shut down on 2026-10-31. Connect, the API and the SDKs go too. Only the registry at smithery.ai remains, "now powered by Arcade.dev" [S1].

### Others

- **Arcade**: smaller but curated (81 servers, 7,500 tools), self-hostable with Helm, free tier of 2,000 calls a month [A1][A2].
- **Zapier MCP**: the biggest app count (9,000+), but it is built around one Zapier account, not a developer embedding it for many end users [Z1].
- **Nango**: an auth and sync platform, 1,000+ APIs. Free self-hosting has a limited feature set under the Elastic License [N2].
- **Klavis** (Apache-2.0, 100+ servers) and **Activepieces** (MIT, 280+ pieces as MCP) are the open-source, self-hostable options. Their catalogs are an order of magnitude smaller [K1][AP1].

## Options for the Bot (owner decision)

Any vendor SDK is a **new dependency**, and a hosted vendor holding users' tokens touches auth. Both are owner decisions (AGENTS.md section 6). Options, from no dependency to most coverage:

1. **CIMD (+ DCR fallback) in `@botsdk/mcp`.** Users or Hosts add any remote MCP server, for example picked from the registry. No vendor, and tokens stay under ADR 0010. Coverage is limited to servers that support CIMD or DCR. Needs the egress and SSRF policy from the mcp-tools research, because URLs stop being Host-curated.
2. **Vendor gateway as one or more `McpServerConfig` entries.** Composio (per-session MCP URL) or Pipedream (one endpoint, per-user headers). This mostly reuses our client. The vendor holds users' OAuth tokens, not our keyring. It needs a per-user header or URL hook that `McpServerConfig` doesn't have today.
3. **Both.** CIMD for first-party servers; a vendor plugin for the long tail.

To match "thousands" on a free tier testable locally, Composio (free Hobby, 1,688 toolkits) fits best. Pipedream's catalog is larger, but it costs money past development mode. Smithery is gone.

## Sources

- [R1] MCP Registry, About: https://modelcontextprotocol.io/registry/about
- [R3] Registry API, counted 2026-10-29 by paging `https://registry.modelcontextprotocol.io/v0/servers?limit=100&version=latest`; stopped at the 500-page cap, so 50,000 is a lower bound
- [R4] MCP spec 2025-11-25, Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- [C1] Composio docs: https://docs.composio.dev/docs/welcome
- [C2] Composio pricing: https://composio.dev/pricing
- [C3] Composio toolkits: https://docs.composio.dev/toolkits
- [C4] Composio custom auth configs: https://docs.composio.dev/docs/custom-auth-configs
- [C5] Composio self-hosting: https://docs.composio.dev/docs/self-hosting
- [P1] Pipedream Connect: https://pipedream.com/docs/connect
- [P2] Pipedream MCP for developers: https://pipedream.com/docs/connect/mcp/developers
- [P3] Pipedream Connect pricing: https://pipedream.com/pricing?plan=Connect
- [S1] Smithery, what's changing: https://smithery.ai/future
- [A1] Arcade docs: https://docs.arcade.dev/en/home
- [A2] Arcade pricing: https://www.arcade.dev/pricing
- [Z1] Zapier MCP: https://zapier.com/mcp
- [N1] Nango docs: https://nango.dev/docs/introduction
- [N2] Nango repo: https://github.com/NangoHQ/nango
- [K1] Klavis repo: https://github.com/Klavis-AI/klavis
- [AP1] Activepieces repo: https://github.com/activepieces/activepieces
- Claude Duet: https://claude.com/product/claude-duet
