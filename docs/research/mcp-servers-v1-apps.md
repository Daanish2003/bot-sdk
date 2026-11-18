# MCP servers for the v1 apps

Research for [#1398](https://github.com/Daanish2003/bot-sdk/issues/1398) (child of map [#1396](https://github.com/Daanish2003/bot-sdk/issues/1396)). Researched 2026-11-18.

## Question

For the fallback path (a curated set of open-source MCP servers behind our own OAuth handling), which open-source MCP servers exist for each v1 app: Gmail, Google Calendar, Google Drive, Slack, GitHub, Notion and Linear?

For each server: who maintains it, license, transport, how it takes a user's credentials, whether one deployment can serve many users, tool coverage, whether tools publish output schemas (needed for code mode), and maintenance activity. Also note where a vendor runs an official remote MCP server the Host could point at instead of self-hosting.

## How to read this

- **Many users from one deployment** means the server takes the user's token **per request** (an `Authorization: Bearer` header), so one process can serve every Connection. A server that reads one token from an env var at startup serves one account per process.
- **Host-minted token** means a token from an OAuth app the Host registered with the provider itself (the map's requirement). Today `@botsdk/mcp` signs in by discovering the authorization server through RFC 9728 and RFC 8414 and using a pre-registered client, with no DCR ([connector-catalog-options](./connector-catalog-options.md#what-we-have-today)).
- Repo facts (license, last commit, latest release, stars) come from the GitHub API on 2026-11-18 [G0].
- **Unverified** marks what I could not confirm from a primary source. Output schemas of hosted servers can only be read from an authenticated `tools/list`, which I did not run.

## Summary

| App                    | Best self-hostable server                                                                    | Many users from one deployment                                                              | Official vendor remote server                                                                | Accepts a Host-minted token?                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail, Calendar, Drive | `taylorwilsdon/google_workspace_mcp` (community, MIT, Python), one server for all three [W1] | Yes, in "external OAuth provider" mode: validates the incoming Google bearer token [W2][W3] | Yes, Google Workspace MCP servers, **Developer Preview** (program membership required) [GW1] | Yes: you create the OAuth client in your own Google Cloud project [GW1]                                                                             |
| Slack                  | `korotovsky/slack-mcp-server` (community, MIT, Go) [SL2]                                     | **No**: one token per process from env [SL2]                                                | Yes, `https://mcp.slack.com/mcp` [SL1]                                                       | Yes, but only if the Host's Slack app is **directory-published or internal**; unlisted apps are prohibited [SL1]                                    |
| GitHub                 | `github/github-mcp-server` (**official**, MIT, Go) [GH1]                                     | Yes: `http` mode takes `Authorization: Bearer` per request [GH2]                            | Yes, `https://api.githubcopilot.com/mcp/` [GH3]                                              | Yes: "each host application must have a registered GitHub App (or OAuth App)" [GH4]                                                                 |
| Notion                 | `makenotion/notion-mcp-server` (official, MIT) but **"no longer actively maintained"** [NO1] | **No**: one `NOTION_TOKEN` per process [NO1]                                                | Yes, `https://mcp.notion.com/mcp` [NO2]                                                      | **Only via MCP-specific OAuth** (DCR or CIMD against Notion MCP's own authorization server); "An MCP access token works only with Notion MCP" [NO3] |
| Linear                 | `tacticlaunch/mcp-linear` (community, MIT, TypeScript) [LI2]                                 | **No**: "Each MCP server process uses one Linear credential" [LI2]                          | Yes, `https://mcp.linear.app/mcp`; not open source as far as the docs say [LI1]              | Yes: accepts `Authorization: Bearer <token>`, including for "an existing Linear OAuth application" [LI1]                                            |

**Gaps.** No open-source server for **Slack, Notion or Linear** can serve many users from one deployment. For those three the realistic options are the vendor's remote server (Slack with its app-listing rule, Notion with its own OAuth server, Linear with a Host-minted token), one process per Connection, or a fork. For Google, the only multi-user server is a community Python project. Google's own servers are still a Developer Preview.

**Output schemas.** Only `github/github-mcp-server` is confirmed to publish them, and only when the client negotiates MCP protocol `2026-07-28` or later [GH1][GH5]. Every other self-hostable server returns formatted text (Google Workspace MCP returns strings, korotovsky's Slack server returns CSV) [W4][SL2]. Hosted servers: unverified.

## Per app

### Gmail, Google Calendar, Google Drive

**Official: Google Workspace MCP servers (remote, Google-hosted)** [GW1]

- Status: "Developer Preview", through the Google Workspace Developer Preview Program, whose membership is a prerequisite.
- Separate Streamable HTTP endpoints per product: Gmail `https://gmailmcp.googleapis.com/mcp/v1`, Drive `https://drivemcp.googleapis.com/mcp/v1`, Calendar `https://calendarmcp.googleapis.com/mcp/v1` (also Docs, Sheets, Slides, Chat, People, Classroom, and a cross-product search at `workspacemcp.googleapis.com`).
- Auth: OAuth 2.0 with a client the Host creates in its own Google Cloud project as a "Web application", with **"Use this client for an AI-powered agent"** selected ("Clients without this setting can be rejected"). Each product's MCP API (`gmailmcp.googleapis.com` etc.) must be enabled in that project. Refresh tokens need `access_type=offline`. DCR is not mentioned.
- Scopes listed: Gmail `gmail.readonly`, `gmail.compose`, `gmail.modify`; Drive `drive.readonly`, `drive.file`; Calendar `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`, `calendar.events`.
- Tools named on the page: Gmail `search_threads`, `get_thread`, `create_draft` (no send is named); Drive `search_files`, `read_file_content`; Calendar `list_events`. Full lists are in per-product reference pages I did not read.
- Not self-hostable (Google's cloud is in the path), so it is a "point at instead" option only. Output schemas: not mentioned. Consumer (`@gmail.com`) account support: unverified.

**Best self-hostable: [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)** (`workspace-mcp` on PyPI)

- Community, MIT, Python (FastMCP `>=4.1.2`). v2.5.0 released 2026-11-14; ~3,500 stars; active [G0][W5].
- Covers Gmail, Calendar, Drive and nine more Workspace services, "120+ tools", with `core` / `extended` / `complete` tiers, `--read-only` and per-service permissions [W1].
- Transport: stdio, or Streamable HTTP; OAuth 2.1 "requires HTTP transport" [W1].
- Credentials, three modes:
  1. Its own OAuth 2.1 proxy (it runs the Google sign-in with your client id and secret, storing state in memory, disk or Valkey/Redis) [W1].
  2. **External OAuth provider mode** (`MCP_ENABLE_OAUTH21=true`, `EXTERNAL_OAUTH21_PROVIDER=true`): "The server skips local OAuth flow and validates incoming bearer tokens" [W2]. In the source, this provider "acts as a Resource Server only", "handles ya29.\* access tokens by calling Google's userinfo API", and serves no `/authorize`, `/token` or `/register` endpoints [W3]. So a Google access token from the Host's own OAuth client works, as long as it carries scopes the userinfo call needs (my reading of the code; I saw no audience check against the server's client id, but did not trace every path).
  3. Stateless mode (`WORKSPACE_MCP_STATELESS_MODE=true`): no disk writes, "Requires OAuth 2.1 and bearer tokens on requests" [W2].
- Many users from one deployment: yes in modes 2 and 3. The README calls itself "the only Workspace MCP you can host for your whole organization centrally" [W1].
- Output schemas: tools return formatted strings (for example `list_gmail_filters(...) -> str`) [W4], so there is no useful output schema for code mode.
- Note: a Python runtime is a new piece of Host infrastructure (AGENTS.md §6).

**Other Google servers (not recommended)**

- [`nspady/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp): MIT, active (v2.8.1, 2026-10-29). Reads a Desktop-app OAuth credentials file and stores tokens itself; "multi-account" means one operator's several accounts, not many end users [CA1].
- [`gemini-cli-extensions/workspace`](https://github.com/gemini-cli-extensions/workspace): Apache-2.0, a Gemini CLI extension for the signed-in local user; v0.0.8 (2026-05-04) [GE1].
- [`GongRzhe/Gmail-MCP-Server`](https://github.com/GongRzhe/Gmail-MCP-Server): archived [G0].
- The reference Google Drive server lives in `modelcontextprotocol/servers-archived`, which is archived ("no longer maintained") [G0].

### Slack

**Official: Slack MCP server (remote, Slack-hosted)** [SL1]

- `https://mcp.slack.com/mcp`, JSON-RPC over Streamable HTTP. "We do not support SSE-based connections or Dynamic Client Registration at this time."
- Auth: the client "must be backed by a registered Slack app" and uses that app's `client_id` and `client_secret` (confidential OAuth). User-token endpoints `https://slack.com/oauth/v2_user/authorize` and `https://slack.com/api/oauth.v2.user.access`; RFC 8414 discovery files at `mcp.slack.com/.well-known/…`. This fits `@botsdk/mcp`'s pre-registered client model.
- **Restriction:** "Only directory-published apps or internal apps may use MCP", and "unlisted apps are prohibited from using MCP". A Host serving users across many workspaces would need its Slack app listed in the Slack Marketplace. Workspace admins approve MCP clients.
- Tools: search messages, files, users, channels, emoji; send, schedule and read messages and threads; create conversations; reactions; canvases; user profiles; channel members; file upload; Lists. Rate limits follow Web API tiers.
- Output schemas: unverified.

**Best self-hostable: [`korotovsky/slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server)**

- Community, MIT, Go. v1.3.0 released 2026-05-14, last commit the same day; ~1,900 stars [G0].
- Transports: stdio, SSE and HTTP [SL2].
- Credentials: one of `SLACK_MCP_XOXP_TOKEN` (user OAuth), `SLACK_MCP_XOXB_TOKEN` (bot), or browser session tokens `xoxc`/`xoxd`, from env. `SLACK_MCP_API_KEY` is only a bearer that gates the HTTP transport [SL2]. **One Slack identity per process**, so many users means one process per Connection.
- Several tools only work with browser session tokens, not OAuth tokens [SL2]. Using scraped session tokens is not something a Host should offer end users.
- Posting is off by default (`SLACK_MCP_ADD_MESSAGE_TOOL`) [SL2]. Results are CSV text [SL2]; no output schemas.

**Gap:** no open-source Slack server takes a per-request token.

### GitHub

**Best self-hostable and official: [`github/github-mcp-server`](https://github.com/github/github-mcp-server)**

- GitHub, MIT, Go. v2.2.0 released 2026-11-16, last commit 2026-11-17; ~34,500 stars [G0].
- Transports: `stdio`, and `github-mcp-server http` (Streamable HTTP, default port 8082) [GH2].
- Credentials: stdio reads `GITHUB_PERSONAL_ACCESS_TOKEN` or runs its own OAuth login [GH1]. **HTTP mode takes the token per request** ("Authorization": "Bearer …", plus optional `X-MCP-Toolsets` and `X-MCP-Readonly` headers), serves `/.well-known/oauth-protected-resource` pointing at `https://github.com/login/oauth`, and with `--scope-challenge` returns 403 with `WWW-Authenticate` when scopes are missing [GH2]. A token from the Host's own GitHub OAuth App or GitHub App works.
- Tool coverage: toolsets for repos, issues, pull requests, Actions, code security, Dependabot, discussions, gists, notifications, orgs, projects and more; filter with `--toolsets` / `--tools` [GH1][GH3].
- Output schemas: **yes**. Typed tools expose output schemas and `structuredContent` "only for a negotiated, SDK-supported protocol version `2026-07-28` or later"; older versions get the legacy text result [GH5]. The README lists repository, gist, issue-metadata and Actions tools among them [GH1]. Which protocol version `@botsdk/mcp` negotiates: unverified here.
- Some mutations (`delete_repository`, repository automations) need `GITHUB_MCP_SERVER_MRTR_STATE_KEY` in HTTP mode or are not exposed [GH2].

**Official remote:** `https://api.githubcopilot.com/mcp/`, with per-toolset URLs and `/readonly` variants; it has extra remote-only tools [GH3]. "When using the Remote GitHub MCP Server, if authenticating with OAuth instead of PAT, each host application must have a registered GitHub App (or OAuth App)" [GH4], so it accepts Host-minted tokens. Organization OAuth App access policies and SSO apply [GH4]. The "MCP servers in Copilot" policy governs Copilot editors only, not third-party hosts [GH4].

### Notion

**Official remote: Notion MCP** [NO2][NO3]

- `https://mcp.notion.com/mcp`, Streamable HTTP; the SSE endpoint retires 2027-02-23 [NO2].
- Auth: OAuth 2.0 with PKCE, discovered through `/.well-known/oauth-protected-resource`. Clients register by DCR ("use the advertised `registration_endpoint`") or a Client ID Metadata Document, then "Register once and store the result per issuer" [NO3]. "An MCP access token works only with Notion MCP" [NO3]. So a token from the Host's Notion **REST API** public integration is not documented as accepted; the Host would register once with Notion MCP's authorization server (DCR or CIMD) and use that client id. `@botsdk/mcp` does neither today.
- Access tokens last "about eight hours"; refresh tokens rotate on every refresh, live at most 180 days, and replaying an old one revokes the grant [NO3].
- MCP tokens (static bearer) exist but need a Business or Enterprise plan and a workspace owner [NO2]. Guests cannot connect [NO2].
- Tools: search (semantic), read and edit pages in Markdown, manage databases [NO1][NO2]. Output schemas: unverified.

**Self-hostable: [`makenotion/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server)** [NO1]

- Notion, MIT, TypeScript (`@notionhq/notion-mcp-server`). v2.1.0 released 2026-01-31; last commit 2026-10-29 [G0].
- README: "This repository is a separate, self-hosted MCP server implementation that is **no longer actively maintained or supported**", and "We may sunset this local MCP server repository in the future."
- Transports: stdio and Streamable HTTP. Credentials: one `NOTION_TOKEN` (an internal integration token) per process; the HTTP `--auth-token` only gates access to the server. **One Notion identity per process.**
- Tools are generated from the Notion OpenAPI spec (data sources, pages, blocks, search, comments) [NO1].

**Gap:** no maintained open-source Notion server, and none that takes a per-request token.

### Linear

**Official remote: Linear MCP** [LI1]

- `https://mcp.linear.app/mcp` (Streamable HTTP), `/mcp/readonly` for read tools only; `/sse` is deprecated. "Centrally hosted and managed"; the docs don't say it is open source.
- Auth: OAuth 2.1 with dynamic client registration by default. It also accepts "Authorization: Bearer <yourtoken>", documented for acting as an `app` user, a read-only API key, and "Integrating an existing Linear OAuth application without an extra authentication hop". So a token from the Host's own Linear OAuth app works. Request only the `read` scope for a read-only token.
- Caveat (inference): the server's protected-resource metadata presumably points at its own DCR authorization server, so `@botsdk/mcp`'s discovery would not land on the Host's Linear OAuth app by itself. The Host would sign in against Linear's normal OAuth endpoints and hand the server the token. Unverified.
- Tools: find, create and update issues, projects, comments and documents; no full list on the page. Output schemas: unverified.

**Self-hostable: [`tacticlaunch/mcp-linear`](https://github.com/tacticlaunch/mcp-linear)** [LI2]

- Community, MIT, TypeScript (`@tacticlaunch/mcp-linear`). v1.4.6 released 2026-11-13; ~150 stars [G0].
- Credentials: a personal API key or `LINEAR_OAUTH_ACCESS_TOKEN` / `--oauth-token`. "Each MCP server process uses one Linear credential." **One identity per process.**
- Tools: issues, projects, teams, plus OAuth-app and webhook management.
- Older options: `jerhadf/linear-mcp-server` (last push 2025-05), `cline/linear-mcp` (no license, last push 2025-08) [G0]. Not recommended.

**Gap:** no open-source Linear server takes a per-request token; Linear's own remote server is the practical choice.

## Implications for the fallback (for the ADR, not decided here)

- Truly self-hosted, many users per deployment, open source today: **GitHub** (official) and **Google** (community, Python). That is four of seven apps.
- **Slack, Notion and Linear** need either the vendor's remote server, or one process per Connection (heavy ops), or a fork that reads the token per request. Whether a vendor's own remote MCP server counts as "vendor cloud in the path" (the vendor's API is in the path anyway) is for the ADR to decide.
- Code mode would get output schemas only from GitHub, and only on MCP `2026-07-28`.
- SDK work the fallback implies: Notion MCP needs DCR or CIMD; Linear needs a way to sign in against the provider's OAuth and pass the token, not discovery from the MCP server.

## Sources

- [G0] GitHub REST API, `GET /repos/{owner}/{repo}`, `/releases/latest`, `/commits`, read 2026-11-18, for license, stars, archived flag, latest release and last commit of every repo named above.
- [GW1] Google, [Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers)
- [W1] [`taylorwilsdon/google_workspace_mcp` README](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/README.md)
- [W2] [workspacemcp.com/docs](https://workspacemcp.com/docs) (maintainer's docs), Authentication section
- [W3] [`auth/external_oauth_provider.py`](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/auth/external_oauth_provider.py) and [`core/server.py`](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/core/server.py)
- [W4] [`gmail/gmail_tools.py`](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/gmail/gmail_tools.py)
- [W5] [`pyproject.toml`](https://github.com/taylorwilsdon/google_workspace_mcp/blob/main/pyproject.toml)
- [CA1] [`nspady/google-calendar-mcp` README](https://github.com/nspady/google-calendar-mcp/blob/main/README.md)
- [GE1] [`gemini-cli-extensions/workspace` README](https://github.com/gemini-cli-extensions/workspace/blob/main/README.md)
- [SL1] Slack, [Slack MCP server overview](https://docs.slack.dev/ai/slack-mcp-server/)
- [SL2] [`korotovsky/slack-mcp-server` README](https://github.com/korotovsky/slack-mcp-server/blob/HEAD/README.md)
- [GH1] [`github/github-mcp-server` README](https://github.com/github/github-mcp-server/blob/main/README.md)
- [GH2] [`docs/streamable-http.md`](https://github.com/github/github-mcp-server/blob/main/docs/streamable-http.md)
- [GH3] [`docs/remote-server.md`](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [GH4] [`docs/policies-and-governance.md`](https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md)
- [GH5] [`docs/typed-tool-schemas.md`](https://github.com/github/github-mcp-server/blob/main/docs/typed-tool-schemas.md)
- [NO1] [`makenotion/notion-mcp-server` README](https://github.com/makenotion/notion-mcp-server/blob/main/README.md)
- [NO2] Notion, [Get started with Notion MCP](https://developers.notion.com/docs/get-started-with-mcp)
- [NO3] Notion, [Build an MCP client for Notion](https://developers.notion.com/guides/mcp/build-mcp-client)
- [LI1] Linear, [MCP server](https://linear.app/docs/mcp)
- [LI2] [`tacticlaunch/mcp-linear` README](https://github.com/tacticlaunch/mcp-linear/blob/main/README.md)
