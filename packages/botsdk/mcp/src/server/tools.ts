import type { AnyServerTool } from "@tanstack/ai";
import { createMCPClient } from "@tanstack/ai-mcp";

import type { BotSdkContext } from "@botsdk/bot/plugin";
import {
  accessTokenFor,
  type ConnectionHook,
  type McpConnection,
  untilAborted,
} from "./connections";

type Deps = Pick<BotSdkContext, "fetch" | "logger">;

/**
 * The tools of the user's connected Connections, one client per Connection, open until `signal`
 * aborts. Each client sends the token the Host's hook answers as a Bearer token, with no OAuth
 * discovery or client registration (ADR 0037). The servers are opened side by side, so a slow one
 * holds up no other. A server that is down or refuses the token (HTTP 401), or a Connection the
 * hook gives no token for, is skipped. Each tool is named `<key>_<tool>`, filtered by the
 * Connection's `mcp.tools` allowlist, and needs approval unless its `approvalFree` lists it. Each
 * tool's `metadata.readOnly` says whether a read-only run may call it: the server marks it
 * `readOnlyHint: true`, or `readOnlyTools` names it.
 */
export async function openMcpTools(
  deps: Deps,
  connections: readonly McpConnection[],
  hook: ConnectionHook | undefined,
  userId: string,
  signal: AbortSignal,
): Promise<AnyServerTool[]> {
  if (signal.aborted) return [];
  const clients: Array<{ close: () => Promise<void> }> = [];
  const closeAll = () => {
    for (const client of clients.splice(0)) void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", closeAll, { once: true });

  const opened = await Promise.all(
    connections.map(async (server): Promise<AnyServerTool[]> => {
      // Raced against the signal: a Stop or the time limit doesn't wait for a slow hook.
      const accessToken = await untilAborted(
        accessTokenFor(deps, hook, userId, server.key),
        signal,
      );
      if (!accessToken || signal.aborted) return [];
      let client: { close: () => Promise<void>; tools: () => Promise<unknown> } | undefined;
      try {
        client = await createMCPClient({
          transport: {
            type: "http",
            url: server.mcp.url,
            headers: { authorization: `Bearer ${accessToken}` },
            fetch: deps.fetch,
          },
          name: "ai-chat",
          prefix: server.key,
          toolFilter: (tool) => !server.mcp.tools || server.mcp.tools.includes(tool.name),
          needsApproval: (tool) => !(server.approvalFree ?? []).includes(tool.name),
        });
        if (signal.aborted) throw signal.reason;
        const tools = ((await client.tools()) as AnyServerTool[]).map((tool) => {
          const meta = tool.metadata?.mcp as
            | { serverToolName?: string; annotations?: { readOnlyHint?: boolean } }
            | undefined;
          const readOnly =
            meta?.annotations?.readOnlyHint === true ||
            (server.readOnlyTools ?? []).includes(meta?.serverToolName ?? "");
          return { ...tool, metadata: { ...tool.metadata, readOnly } } as AnyServerTool;
        });
        clients.push(client);
        // A client opened as the signal aborted is closed at once.
        if (signal.aborted) closeAll();
        return tools;
      } catch {
        // The server is down or refused the call: its tools are left out and its client closed.
        void client?.close().catch(() => undefined);
        return [];
      }
    }),
  );
  // With no client left open, the signal has nothing to close.
  if (clients.length === 0) signal.removeEventListener("abort", closeAll);
  return signal.aborted ? [] : opened.flat();
}
