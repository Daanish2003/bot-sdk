import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useOrpc } from "@botsdk/react/provider";
import type { McpContract } from "../shared/contract";

/*
 * The `mcp` feature's hooks (spec #875): TanStack Query over its procedures, for a UI inside a
 * `<BotSdkProvider>` whose client has `mcpClient()`. The refresh hook refetches what a change
 * makes stale.
 */

function useMcp() {
  return useOrpc<{ mcp: McpContract }>().mcp;
}

/** The Connections the Host declares, with the user's state for each (`mcp.listConnections`). */
export function useMcpConnections() {
  return useQuery(useMcp().listConnections.queryOptions());
}

/** Refetches everything the `mcp` feature read, after the Host connected or disconnected one. */
export function useRefreshMcp() {
  const mcp = useMcp();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: mcp.key() });
}
