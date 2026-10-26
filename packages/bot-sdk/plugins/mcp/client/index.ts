import type { FeatureClient } from "../../../core/client/chat-client";
import { mcpContract, type McpContract } from "../shared/contract";

export type { McpContract };

/** The URL the `mcp` feature adds to the client. */
export type McpUrls = {
  /** Where the MCP sign-in starts (`GET ?server=<key>&returnTo=<path>`) and finishes. */
  connectionsUrl: string;
};

export type McpFeatureClient = FeatureClient<"mcp", McpContract, McpUrls>;

/** The `mcp` feature's client part: its contract, served under `mcp`, and the MCP sign-in URL. */
export function mcpClient(): McpFeatureClient {
  return { id: "mcp", contract: mcpContract, urls: (base) => ({ connectionsUrl: `${base}/mcp` }) };
}
