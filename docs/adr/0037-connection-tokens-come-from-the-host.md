---
Status: accepted
---

# A Connection's token comes from the Host through a hook

Connections (map #1396) are a user's sign-ins to apps such as Gmail and GitHub, and their tools are Connector tools. Until now `@botsdk/mcp` ran its own OAuth against a client the Host registered for each MCP server, and stored the tokens in its own encrypted `connections` table. With Better Auth already holding OAuth tokens on the Host (ADR 0023), Connections take the same seam as linked Provider credentials (#1404).

- **Hook:** the `mcp` plugin takes a Host hook, `connection(userId, key)`, that returns `{ accessToken }`, `{ reconnect: true }` (linked, but the refresh failed) or `null` (never linked). The Bot SDK derives each Connection's state from it, for the Settings section, the Prompt start and the first-Connection Change note.
- **Host:** each Connection is its own link-only Better Auth provider id, never a sign-in method, like `chatgpt`. Better Auth runs the OAuth flow, encrypts the tokens and refreshes them. The Host declares each Connection with either `mcp: { url }`, an MCP server it sends the token to as a Bearer token, or `tools`, which it wrote itself and whose `execute` gets the token. The Host also owns Connect, Reconnect and Disconnect in the Settings UI.
- **Bot SDK:** it lists Connector tools as Deferred tools, Auto-reviews calls, masks, cuts and fences results, applies the approval-free and read-only marks, and answers the reconnect error. Tools from both sources get the same treatment.
- **Removed:** `@botsdk/mcp`'s OAuth flow, its sign-in routes, its `connections` table, the per-server `oauth` config, and the `MCP_SERVER_*` variables.

## Considered Options

- **Keep `@botsdk/mcp`'s own OAuth beside the hook:** this would serve a Host without its own auth. But it means two token stores and two OAuth clients to maintain, for a Host that has Better Auth anyway.
- **Add scopes to the Google and GitHub sign-in rows with `linkSocial`:** this avoids extra provider ids. But a later sign-in overwrites the row's tokens. A different account than the sign-in one would become a sign-in method. And `getAccessToken` can't pick between two rows of one provider.
- **An aggregator (Composio, Nango, Activepieces):** ruled out for a personal Host (#1400).

## Consequences

- Dropping the `connections` table deletes any existing MCP Connection. It must be connected again through Better Auth.
- An official MCP server fits only if it accepts a token we mint. Servers that require their own authorization server, such as Notion MCP, need a client registered with that server once.
- A refresh failure that Better Auth doesn't see, such as Slack's HTTP 200 `ok:false`, must be reported as a reconnect by the tool itself.
