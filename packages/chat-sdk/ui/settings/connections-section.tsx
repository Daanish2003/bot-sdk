import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useChatAdapter, useOrpc } from "../../core/client/react/provider";

const stateLabel = {
  connected: "Connected",
  reconnect: "Reconnect needed",
  disconnected: "Not connected",
} as const;

/**
 * The keys page's Connections: the MCP servers the Host offers, with Connect, Reconnect and
 * Disconnect. Hidden entirely when the Host lists none (spec #91).
 */
export function ConnectionsSection() {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const { connectionsUrl } = useChatAdapter();
  const connections = useQuery(orpc.connections.list.queryOptions());
  const disconnect = useMutation(
    orpc.connections.disconnect.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.connections.key() }),
      onError: (error) => toast.error(error.message),
    }),
  );
  const servers = connections.data?.servers ?? [];
  if (servers.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Connections</h2>
      <p className="text-xs text-muted-foreground">
        Servers your app offers. Signing in connects your account to them.
      </p>
      <ul className="divide-y overflow-hidden rounded-xl border">
        {servers.map((server) => (
          <li key={server.key} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 space-y-0.5">
              <span className="text-sm font-medium">{server.name}</span>
              <p className="text-xs text-muted-foreground">
                {stateLabel[server.state]}
                {server.scopes.length > 0 && ` · Scopes: ${server.scopes.join(", ")}`}
              </p>
            </div>
            <div className="flex gap-2">
              {server.state !== "connected" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // The sign-in is a redirect through the server, so it is a page load, not a request.
                    const returnTo = encodeURIComponent(window.location.pathname);
                    window.location.assign(
                      `${connectionsUrl}/connect?server=${encodeURIComponent(server.key)}&returnTo=${returnTo}`,
                    );
                  }}
                >
                  {server.state === "reconnect" ? "Reconnect" : "Connect"}
                </Button>
              )}
              {server.state !== "disconnected" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate({ key: server.key })}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
