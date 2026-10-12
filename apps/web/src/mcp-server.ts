import type { McpServerConfig } from "@ai-chat/chat-sdk/server";

/**
 * The one optional MCP server `apps/web` offers, from its `MCP_SERVER_*` variables (`.env.schema`).
 * Set all five or none: without them users see no Connections section and no MCP tools.
 */
const variables = [
  "MCP_SERVER_KEY",
  "MCP_SERVER_NAME",
  "MCP_SERVER_URL",
  "MCP_SERVER_OAUTH_CLIENT_ID",
  "MCP_SERVER_OAUTH_CLIENT_SECRET",
] as const;

type McpEnv = Partial<Record<(typeof variables)[number], string | undefined>>;

export function mcpServersOf(env: McpEnv): McpServerConfig[] {
  const missing = variables.filter((name) => !env[name]);
  if (missing.length === variables.length) return [];
  if (missing.length > 0) {
    throw new Error(`An MCP server needs ${variables.join(", ")}; missing ${missing.join(", ")}`);
  }
  return [
    {
      key: env.MCP_SERVER_KEY ?? "",
      name: env.MCP_SERVER_NAME ?? "",
      url: env.MCP_SERVER_URL ?? "",
      oauth: {
        clientId: env.MCP_SERVER_OAUTH_CLIENT_ID ?? "",
        clientSecret: env.MCP_SERVER_OAUTH_CLIENT_SECRET ?? "",
      },
    },
  ];
}
