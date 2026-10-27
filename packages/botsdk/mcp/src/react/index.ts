import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useOrpc } from "@botsdk/react/provider";
import type { McpContract } from "../shared/contract";

/*
 * The `mcp` feature's hooks (spec #875): TanStack Query over its procedures, for a UI inside a
 * `<BotSdkProvider>` whose client has `mcpClient()`. A mutation hook takes the procedure's mutation
 * options (`onSuccess`, `onError`…); the refresh hook refetches what a change makes stale.
 */

function useMcp() {
  return useOrpc<{ mcp: McpContract }>().mcp;
}

type Mcp = ReturnType<typeof useMcp>;
/** A procedure's mutation options, as its TanStack Query helper takes them. */
type MutationOptions<Procedure extends { mutationOptions: (...args: never[]) => unknown }> =
  Parameters<Procedure["mutationOptions"]>[0];

/** The MCP servers the Host offers, with the user's connection to each (`mcp.listConnections`). */
export function useMcpConnections() {
  return useQuery(useMcp().listConnections.queryOptions());
}

/** Forgets the user's connection to one MCP server (`mcp.disconnect`). */
export function useDisconnectMcpServer(options?: MutationOptions<Mcp["disconnect"]>) {
  return useMutation(useMcp().disconnect.mutationOptions(options));
}

/** Refetches everything the `mcp` feature read, after a connection changed. */
export function useRefreshMcp() {
  const mcp = useMcp();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: mcp.key() });
}
