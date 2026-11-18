# Self-hostable aggregator survey

Research for [#1397](https://github.com/Daanish2003/bot-sdk/issues/1397) (child of map [#1396](https://github.com/Daanish2003/bot-sdk/issues/1396)). Researched 2026-11-18, from each product's repo, LICENSE file and self-hosting docs (read from the repo where the docs live there). Follows on from [connector-catalog-options.md](./connector-catalog-options.md), which compared hosted catalogs.

## Question

Which self-hostable integration aggregators meet the hard requirements in the map's Notes, and how does each score?

Hard requirements (from #1396): self-hostable end to end with no vendor cloud in the path; per-end-user accounts keyed by our user id; the Host registers its own OAuth apps; tools exposed as an MCP server; tokens encrypted at rest on Host infrastructure; ops ceiling of its own Postgres plus Redis; v1 apps Gmail, Google Calendar, Google Drive, Slack, GitHub, Notion, Linear. Source-available (ELv2, fair-code) is acceptable.

## Answer in one paragraph

**No candidate meets every hard requirement in a form we can self-host for free.** The two that come closest each fail one requirement: **Nango** (free self-hosted) has the auth half exactly right (per-user connections tagged with our user id, our own OAuth apps, AES-encrypted tokens in our Postgres, Postgres + Redis only, all seven v1 apps) but its free self-hosted edition has **no MCP server and no tool calls**, only Auth and Proxy [N1]. **Activepieces** Community Edition (MIT) has an MCP server, all seven v1 apps and a Postgres + Redis footprint, but **per-end-user accounts keyed by an external id are an Enterprise feature** (embedding) [AP3], its default OAuth exchange goes through `secrets.activepieces.com` [AP5], and its MCP server exposes generic meta-tools rather than one tool per action [AP6]. Composio, Pipedream and Arcade have no self-hostable source; Klavis is deprecated; n8n has no per-caller credentials.

## Comparison

| Candidate                           | License                                                                | All self-hosted, no vendor cloud                                                                                                    | Per-user, our id                                                                               | BYO OAuth apps                                                                   | MCP server                                                                | v1 apps (7)                                                      | Infra                                                                                   | Tokens encrypted at rest                                        | Input + output schemas                                                                            | Activity                              |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Nango** (free self-hosted)        | ELv2 [N2]                                                              | Yes; only anonymous usage metrics are reported [N1]                                                                                 | Yes: Connect session `tags.end_user_id` [N4]                                                   | Yes (integration holds your client id/secret) [N5]                               | **No** (free edition: MCP server No, Tool calls No) [N1]                  | 7/7 [N3]                                                         | Server + Postgres + Redis [N6]                                                          | Yes with `NANGO_ENCRYPTION_KEY`; plaintext without it [N1]      | Yes for tools (zod `input` + `output`) [N7], but tools are not in free edition                    | v0.72.6, 2026-11-16 [G]               |
| **Nango** (Enterprise self-managed) | ELv2, paid Enterprise plan [N1]                                        | Yes ("Nothing" leaves your account) [N1]                                                                                            | Yes [N4]                                                                                       | Yes                                                                              | Yes [N1]                                                                  | 7/7                                                              | **5 Node services + Postgres + Redis + Elasticsearch/OpenSearch + object storage** [N1] | Yes [N1]                                                        | Yes [N7]                                                                                          | as above                              |
| **Activepieces** CE                 | MIT outside `packages/ee`; EE dirs commercial [AP1]                    | **Partly**: `CLOUD_OAUTH2` connections exchange codes via `secrets.activepieces.com`, and `cloudAuthEnabled` defaults to true [AP5] | **Enterprise only**: `externalUserId` / `externalProjectId` via embedding [AP3][AP4]           | Per connection (`OAUTH2`) in CE; platform-wide override is Enterprise [AP5][AP7] | Yes, one per project, OAuth-protected, meta-tools (`ap_run_action`) [AP6] | 7/7 pieces [AP8]                                                 | App + worker + Postgres + Redis (BullMQ); Redis can be in-process [AP2][AP9]            | Yes, AES-256 under `AP_ENCRYPTION_KEY` [AP5][AP9]               | Input via `ap_get_piece_props`; output is an optional display schema, not JSON Schema [AP6][AP10] | 0.93.0, 2026-11-08 [G]                |
| **n8n**                             | Sustainable Use License; `.ee` files need Enterprise license [8N1]     | Yes                                                                                                                                 | **No**: credentials are fixed per workflow; MCP auth is "n8n User Auth" for n8n accounts [8N3] | Yes (credential overwrites) [8N4]                                                | Yes, MCP Server Trigger, SSE + Streamable HTTP [8N3]                      | Not checked                                                      | Not checked                                                                             | Not checked                                                     | Not checked                                                                                       | n8n@2.48.5, 2026-11-18 [G]            |
| **Composio**                        | MIT for the SDK repo only [C1]                                         | **No**: the repo is SDKs and CLI; the platform is Enterprise-only Helm, source not public [C1][C2]                                  | (Cloud) yes                                                                                    | (Cloud) yes                                                                      | (Cloud) yes                                                               | n/a                                                              | Not documented [C2]                                                                     | Not documented                                                  | n/a                                                                                               | @composio/cli 0.6.2, 2026-11-16 [G]   |
| **Pipedream** Connect               | Pipedream Source Available License, excludes "any commercial use" [P1] | **No**: even the self-hosted MCP server needs a Pipedream project and calls `api.pipedream.com` [P2]                                | Yes (`x-pd-external-user-id`) [P2]                                                             | n/a                                                                              | Remote, vendor-hosted [P2]                                                | n/a                                                              | n/a                                                                                     | n/a                                                             | n/a                                                                                               | no GitHub releases [G]                |
| **Arcade**                          | `arcade-mcp` framework MIT; the Engine has no public repo [A1][G]      | **No**: Engine is proprietary; Helm self-host documented for enterprise customers [A2][A3]                                          | Yes (Cloud/Engine)                                                                             | Yes, via Arcade Dashboard [A1]                                                   | Yes, via Engine                                                           | n/a                                                              | Kubernetes + Postgres + Redis + an OIDC IdP [A2]                                        | "encryption keys" listed, not described [A2]                    | n/a                                                                                               | arcade-mcp pushed 2026-11-17 [G]      |
| **Klavis**                          | Apache-2.0 [K1]                                                        | Repo **deprecated** (archived on GitHub) [K1][G]                                                                                    | -                                                                                              | -                                                                                | -                                                                         | -                                                                | -                                                                                       | -                                                               | -                                                                                                 | archived; last release 2026-01-29 [G] |
| **IBM ContextForge** (gateway)      | Apache-2.0 [G]                                                         | Yes                                                                                                                                 | Per ContextForge user (keyed by email) [CF2]                                                   | Yes (it is a client of upstream OAuth) [CF1]                                     | Yes, virtual servers over Streamable HTTP [CF1]                           | **None bundled**: fronts upstream MCP servers or REST APIs [CF1] | Gateway + Postgres + Redis [CF1]                                                        | Tokens go through an encryption service in its DB backend [CF2] | Depends on upstream server                                                                        | v1.1.1, 2026-11-10 [G]                |

`[G]` is the GitHub API (`gh api repos/<repo>` and `/releases/latest`), queried 2026-11-18.

## Findings per candidate

### Nango

- **License**: Elastic License 2.0. You may not offer it "as a hosted or managed service" or "circumvent the license key functionality" [N2]. Running it behind a Host's own product is the use ELv2 allows.
- **Two self-hosting tiers.** BYOC and Self-Managed both "require an Enterprise plan subscription"; pricing is "a fixed annual license and maintenance fee, plus a fraction of the Cloud usage-based fees" [N1]. Separately, "a limited free self-hosting option is available for hobby projects ... that need Auth and Proxy" [N1].
- **Free edition feature table** [N1]: API Auth Yes, Proxy Yes; Pre-built syncs, tools & triggers **No**; Tool calls **No**; Webhooks **No**; **MCP server No**.
- **Footprint**: the free edition's `docker-compose.yaml` runs `nango-server`, `postgres:16` and `redis:7.2.4`; Elasticsearch is commented out as optional [N6]. The Enterprise architecture adds Orchestrator, Jobs, Runner and Persist services, object storage and ElasticSearch [N1]; that is past the ops ceiling.
- **Per-user**: Connect sessions take a `tags` object (`end_user_id`, `organization_id`), copied onto the connection; the older `end_user` field is deprecated [N4].
- **Encryption**: "You must provide your own encryption key via `NANGO_ENCRYPTION_KEY` ... Without this key, credentials are stored unencrypted" [N1]. Nango Cloud uses AES-256-GCM with envelope keys in AWS KMS [N5]; how the self-hosted key is applied beyond "encrypts credentials in the control-plane database" is not documented on the pages read.
- **Trust model**: "A self-hosted Nango instance is intended for a single organization ... not designed or hardened as a security boundary between users who don't trust each other" [N1]. That is about dashboard accounts, not end users, and fits one Host per instance.
- **Coverage**: `providers.yaml` has `google-mail`, `google-calendar`, `google-drive`, `slack`, `github` (and `github-app`), `notion`, `linear` [N3].
- **Schemas**: tools declare zod `input` and `output` schemas, and Nango validates input [N7], which suits code mode. But tools need the Enterprise or Cloud edition.
- **What it would take**: use free Nango as the token vault and OAuth broker, and run our own MCP servers (or open-source ones) that fetch a token or call through the Proxy per call. That is the map's fallback with Nango doing the OAuth handling, not an aggregator that "exposes tools as MCP".

### Activepieces

- **License**: MIT, except `packages/ee/` and `packages/server/api/src/app/ee`, which use `packages/ee/LICENSE` [AP1].
- **Architecture**: App, Worker, Sandbox, Engine, UI; Postgres and Redis (BullMQ) [AP2]. `AP_DB_TYPE` can be `PGLITE`; `AP_REDIS_TYPE` can be `MEMORY` [AP9]. Well inside the ops ceiling.
- **MCP server**: "Every Activepieces project can act as an MCP server", toggled in Settings, authenticated with OAuth [AP3][AP6]. Its tools are meta-tools: discovery (`ap_research_pieces`, `ap_get_piece_props`), flow management, and `ap_run_action`, which takes `pieceName`, `actionName`, `input` and `connectionExternalId` [AP6]. The model has to discover and run actions through these, not call `gmail_send_email` directly. Semantic tool search needs `AP_TOOL_SEARCH_ENABLED=true`, an OpenAI key and pgvector [AP6]. The transport is not stated in the docs read; the server package imports the MCP SDK's Streamable HTTP _client_ transport [AP11], so the server side is unverified.
- **Per-end-user is Enterprise.** Mapping our users to Activepieces projects is done by signing a JWT with `externalUserId` and `externalProjectId` [AP4], and "Embedding is available on our enterprise plan" [AP3]. The embeddable MCP flow returns "a token for that one user's project" [AP3]. In CE, a project is `PERSONAL` (auto-created per Activepieces user); team projects are EE [AP12]. Provisioning one Activepieces account per end user ourselves in CE is unverified.
- **OAuth apps**: connection types include `OAUTH2`, `CLOUD_OAUTH2` "(exchanged via `secrets.activepieces.com`)", and `PLATFORM_OAUTH2` [AP5]. The repo's own notes say `CLOUD_OAUTH2` "means managed app, not on Cloud, and `platform.cloudAuthEnabled` defaults to true everywhere" [AP5]. Replacing the default apps platform-wide is an Enterprise feature [AP7]. So a CE Host has to make sure every connection uses its own `OAUTH2` client, or the vendor sits in the sign-in path.
- **Encryption**: connection `value` is "encrypted AES-256" [AP5] under `AP_ENCRYPTION_KEY` [AP9]; OAuth refresh takes a Redis lock [AP5].
- **Coverage**: community pieces exist for `gmail`, `google-calendar`, `google-drive`, `slack`, `github`, `notion`, `linear` [AP8].
- **Schemas**: action input comes from piece props; the output schema is an optional `OutputSchemaField` tree for the data selector, not JSON Schema [AP10].

### n8n

- **License**: Sustainable Use License, "only for your own internal business purposes" [8N1]. The FAQ allows "Use n8n behind the scenes in your own product, where users can use and trigger the automations you built, and even connect their own accounts to them", but not letting end users "build or modify workflows" by any interface, "UI, n8n API, MCP, or an AI agent acting for the user" [8N2]. A Bot composing tool calls is close to that line; ask `license@n8n.io` before relying on it.
- **MCP**: the MCP Server Trigger node exposes attached tool nodes over SSE and Streamable HTTP. Client auth is None, Bearer, Header, or "n8n User Auth (OAuth2)", where "the caller has to give consent to use their n8n account" [8N3].
- **Fails per-user**: a tool node's credential is chosen in the workflow, so every caller uses the same one, unless each end user is an n8n account with their own workflow. Embedding n8n for many end users is the OEM offering, which "requires a separate commercial agreement" [8N4]. Infra, coverage and encryption were not checked further.

### Composio

- The `ComposioHQ/composio` repo is MIT but "is the Composio SDK monorepo": TypeScript and Python SDKs, the CLI and provider adapters [C1]. Its quickstart needs a `COMPOSIO_API_KEY` from the dashboard [C1].
- Self-hosting is an "Enterprise arrangement, with Helm deployment support"; the page names no components, license, or whether it needs a license key [C2]. No platform source is public. **Fails self-hosting and license.**

### Pipedream Connect

- The repo's components are under the Pipedream Source Available License, whose "Excluded Purpose" is "any commercial use of the software" [P1].
- The developer MCP page offers a "remote or self-hosted MCP server", but either one needs "a Pipedream account", "a Pipedream project, where MCP-connected accounts are stored" and client-credentials OAuth against `api.pipedream.com` [P2]. Tokens stay in Pipedream's cloud. **Fails self-hosting.**

### Arcade

- `ArcadeAI/arcade-mcp` (MIT) is a framework for writing MCP servers. Authorized tool calling relies on the Arcade Engine: "When the tool is invoked through Arcade Cloud, the user is presented with a URL to complete the OAuth challenge" [A1]. No Engine source repo exists in the ArcadeAI GitHub org [G].
- Helm self-hosting needs Kubernetes, Postgres, Redis and an OIDC IdP [A2]; the engine configuration guide is "for enterprise customers who are self-hosting the Arcade Engine" [A3]. **Fails license (proprietary engine).**

### Klavis

- The README opens "This repository is deprecated and is no longer under active development ... Klavis AI now focuses on RL environments" [K1], and GitHub marks it archived [G]. **Out.** Its Apache-2.0 per-app MCP servers could still be forked as fallback material.

### IBM ContextForge (other option found)

- An Apache-2.0 "registry and proxy that federates any MCP server, A2A server, or REST/gRPC API", with "user-scoped OAuth tokens", a REST-to-MCP adapter, virtual servers served over Streamable HTTP, and a Docker Compose stack of PostgreSQL and Redis [CF1].
- Upstream OAuth tokens are stored per gateway and per ContextForge user email, through an encryption service [CF2]. Keying by our user id would mean one ContextForge user per end user (for example a synthetic email); that mapping is unverified.
- It bundles **no apps**. It is a gateway for the fallback path, not an aggregator.

Other projects looked at and dropped: `metatool-ai/metamcp` (archived), `picahq/pica` community edition (archived, last release 2025-07-16), `obot-platform/obot` (MIT MCP gateway and governance platform; users come from its own auth providers, and hosted servers run as Docker or Kubernetes workloads beyond the ops ceiling) [G][OB1], `stacklok/toolhive` (Apache-2.0, runs MCP servers, not an app catalog) [G].

## Ranked shortlist

None passes every hard requirement. Ranked by how little has to give:

1. **Nango, free self-hosted, as the OAuth broker and token vault, with our own MCP layer** (the fallback with Nango handling OAuth). Passes self-hosting, per-user keyed by our id, BYO OAuth, encryption at rest, Postgres + Redis, 7/7 apps. **Fails "exposes tools as MCP"**: we would write or adopt the MCP servers ourselves. ELv2.
2. **Activepieces CE.** Passes license (MIT), ops ceiling, MCP, 7/7 apps, encryption. **Fails per-user keyed by our id** without the Enterprise embedding plan, and needs care to keep `secrets.activepieces.com` out of the OAuth path. Its MCP tools are generic meta-tools, which costs model turns and gives weak output schemas for code mode.
3. **Curated open-source MCP servers behind a gateway such as IBM ContextForge.** Passes license, self-hosting, Postgres + Redis, per-user OAuth (by gateway user). **Fails "bundled v1 apps"**: each of the seven needs an MCP server picked and vetted.

## Unverified

- Whether Nango's self-hosted Connect UI and API work for an integration without a Nango-provided OAuth app (we assume you must enter your own client id and secret, which is what we want), and how `NANGO_ENCRYPTION_KEY` is applied on self-hosted instances (the security page describes Cloud's KMS setup).
- Activepieces' MCP server transport (Streamable HTTP or SSE), and whether CE can provision one Activepieces user and project per end user without the Enterprise embedding plan.
- Whether `CLOUD_OAUTH2` can be switched off on a CE instance so that only `OAUTH2` connections exist.
- Composio's and Arcade's self-hosted architecture and license terms (not public; sales only).
- n8n infra, coverage and encryption (not pursued once per-user failed).
- ContextForge's user model when the Host mints its JWTs, and which algorithm its encryption service uses.
- Which of the seven v1 apps have a usable open-source or first-party remote MCP server (needed for options 1 and 3; not surveyed here).

## Sources

- [N1] Nango, Self-host Nango (overview, free self-hosting table, Self-Managed configuration, encryption key): `docs/guides/platform/self-hosting/self-hosting.mdx` and `self-managed.mdx` in https://github.com/NangoHQ/nango
- [N2] Nango LICENSE (Elastic License 2.0): https://github.com/NangoHQ/nango/blob/master/LICENSE
- [N3] Nango `packages/providers/providers.yaml`: https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml
- [N4] Nango, Migrate from end user (tags): `docs/guides/platform/migrations/migrate-from-end-user.mdx`
- [N5] Nango, Security: `docs/guides/platform/security.mdx`
- [N6] Nango `docker-compose.yaml`: https://github.com/NangoHQ/nango/blob/master/docker-compose.yaml
- [N7] Nango, Tools: `docs/guides/functions/tools.mdx`
- [AP1] Activepieces LICENSE: https://github.com/activepieces/activepieces/blob/main/LICENSE
- [AP2] Activepieces, Architecture overview: `docs/install/architecture/overview.mdx`
- [AP3] Activepieces, Embeddable MCP and the Enterprise embedding note: `docs/embedding/embeddable-mcp.mdx`, `docs/_snippets/embed-feature.mdx`
- [AP4] Activepieces, Provision users: `docs/embedding/provision-users.mdx`
- [AP5] Activepieces, App Connections internals: `brain/knowledge/connections-auth/app-connections.md`
- [AP6] Activepieces, MCP server, tools and tool search: `docs/mcp/overview.mdx`, `docs/mcp/tools.mdx`, `docs/mcp/tool-search.mdx`
- [AP7] Activepieces, Override OAuth2 apps (Enterprise): `docs/admin-guide/guides/manage-oauth2.mdx`
- [AP8] Activepieces pieces: `packages/pieces/community/{gmail,google-calendar,google-drive,slack,github,notion,linear}`
- [AP9] Activepieces, Environment variables: `docs/install/reference/environment-variables.mdx`
- [AP10] Activepieces pieces framework: `packages/pieces/framework/src/lib/output-schema.ts`
- [AP11] Activepieces `packages/server/utils/src/mcp-transport.ts`
- [AP12] Activepieces, Platform & Editions: `brain/knowledge/platform-editions-ee/index.md`
- [8N1] n8n LICENSE.md: https://github.com/n8n-io/n8n/blob/master/LICENSE.md
- [8N2] n8n License FAQ: https://docs.n8n.io/n8n-community-license/community-license/license-faq.md
- [8N3] n8n MCP Server Trigger: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger.md
- [8N4] n8n, Deploy as an OEM integration: https://docs.n8n.io/deploy/host-n8n/deploy-as-an-oem-integration.md
- [C1] Composio repo README and LICENSE: https://github.com/ComposioHQ/composio
- [C2] Composio self-hosting: https://docs.composio.dev/docs/self-hosting
- [P1] Pipedream LICENSE: https://github.com/PipedreamHQ/pipedream/blob/master/LICENSE
- [P2] Pipedream MCP for developers: https://pipedream.com/docs/connect/mcp/developers
- [A1] arcade-mcp README: https://github.com/ArcadeAI/arcade-mcp
- [A2] Arcade, Self-host with Helm: https://docs.arcade.dev/en/operate/deploy/helm
- [A3] Arcade, Configure engine (search snippet; the page itself returned 404 when fetched): https://docs.arcade.dev/en/guides/deployment-hosting/configure-engine.md
- [K1] Klavis README: https://github.com/Klavis-AI/klavis
- [CF1] IBM ContextForge README: https://github.com/IBM/mcp-context-forge
- [CF2] ContextForge `mcpgateway/services/token_storage_service.py`
- [OB1] Obot README: https://github.com/obot-platform/obot
