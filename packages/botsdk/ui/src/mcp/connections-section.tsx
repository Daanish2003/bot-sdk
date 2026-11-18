import { Button } from "@/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { useMcpConnections, useRefreshMcp } from "@botsdk/mcp/react";
import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";

/**
 * What the Host provides for Connections (ADR 0037): how a user connects and disconnects one, by
 * its key. The Bot SDK has no auth, so the Host owns both. Reconnect runs `connect` again.
 */
export type ConnectionsHost = {
  /** Starts connecting; the Host's auth takes the browser away and returns to the Keys page. */
  connect: (key: string) => void | Promise<void>;
  disconnect: (key: string) => void | Promise<void>;
};

const stateKeys = {
  connected: "settings.connected",
  reconnect: "settings.reconnectNeeded",
  disconnected: "settings.notConnected",
} as const;

/**
 * The Keys page's Connections: the ones the Host declares, with their state, and Connect,
 * Reconnect and Disconnect through the Host. Hidden entirely when the Host declares none.
 */
export function ConnectionsSection({ host }: { host: ConnectionsHost }) {
  const i18n = useI18n();
  const { t } = i18n;
  const connections = useMcpConnections();
  const refresh = useRefreshMcp();
  const connect = useMutation({
    mutationFn: (key: string) => Promise.resolve(host.connect(key)),
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const disconnect = useMutation({
    mutationFn: (key: string) => Promise.resolve(host.disconnect(key)),
    onSuccess: refresh,
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const rows = connections.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.connections")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.connectionsHelp")}</p>
      <ul className="divide-y overflow-hidden rounded-xl border">
        {rows.map((connection) => (
          <li key={connection.key} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 space-y-0.5">
              <span className="text-sm font-medium">{connection.name}</span>
              <p className="text-xs text-muted-foreground">{t(stateKeys[connection.state])}</p>
            </div>
            <div className="flex gap-2">
              {connection.state !== "connected" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={connect.isPending}
                  onClick={() => connect.mutate(connection.key)}
                >
                  {connection.state === "reconnect"
                    ? t("settings.reconnect")
                    : t("settings.connect")}
                </Button>
              )}
              {connection.state !== "disconnected" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(connection.key)}
                >
                  {t("settings.disconnect")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
