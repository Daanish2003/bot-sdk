import type { FeatureClient } from "@botsdk/client";

import { mcpContract, type McpContract } from "../shared/contract";

export type { McpContract };

export type McpFeatureClient = FeatureClient<"mcp", McpContract>;

/** The `mcp` feature's client part: its contract, served under `mcp`. It adds no URLs. */
export function mcpClient(): McpFeatureClient {
  return { id: "mcp", contract: mcpContract };
}
