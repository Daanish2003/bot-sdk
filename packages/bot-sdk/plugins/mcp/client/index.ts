import type { BotSdkClient } from "../../../core/client/chat-client";
import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { McpRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    mcp: McpRouter;
  }
}

declare module "../../../core/client/chat-client" {
  /** The URL the `mcp` plugin adds to the client. */
  interface BotSdkClient {
    /** Where the MCP sign-in starts (`GET ?server=<key>&returnTo=<path>`) and finishes. */
    connectionsUrl: string;
  }
}

export type McpClientPlugin = BotSdkClientPlugin<"mcp", McpRouter> & {
  urls: (base: string) => Pick<BotSdkClient, "connectionsUrl">;
};

/** The `mcp` plugin's client: its router is `connections`, and it adds the MCP sign-in URL. */
export function mcpClient(): McpClientPlugin {
  return { id: "mcp", urls: (base) => ({ connectionsUrl: `${base}/mcp` }) };
}
