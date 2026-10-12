/**
 * The composer's tools menu for MCP servers (spec #91). It lists only the servers the user is
 * connected to, each on when the Conversation has it switched on. A server the Host lists but the
 * user isn't connected to is left out, so nothing shows when there are none.
 */
export type McpMenuServer = {
  key: string;
  name: string;
  state: "connected" | "reconnect" | "disconnected";
};

export type McpMenuItem = { key: string; name: string; on: boolean };

export function mcpToolsMenu(servers: McpMenuServer[], connections: string[]): McpMenuItem[] {
  return servers
    .filter((server) => server.state === "connected")
    .map(({ key, name }) => ({ key, name, on: connections.includes(key) }));
}

/** The Connections after one server is switched on or off, in the order they were switched on. */
export function switchConnection(connections: string[], key: string, on: boolean): string[] {
  const rest = connections.filter((connection) => connection !== key);
  return on ? [...rest, key] : rest;
}
