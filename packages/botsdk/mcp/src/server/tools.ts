import {
  type AnyServerTool,
  type SchemaInput,
  toolDefinition,
  validateWithStandardSchema,
} from "@tanstack/ai";
import { createMCPClient } from "@tanstack/ai-mcp";

import type { BotSdkContext } from "@botsdk/bot/plugin";
import {
  accessTokenFor,
  ConnectionBrokenError,
  type ConnectionHook,
  type HostTool,
  type McpConnection,
  untilAborted,
} from "./connections";

type Deps = Pick<BotSdkContext, "fetch" | "logger">;

/**
 * The tools of the user's connected Connections, open until `signal` aborts (ADR 0037). An MCP
 * source gets one client per Connection, which sends the token the Host's hook answers as a Bearer
 * token, with no OAuth discovery or client registration; a Host-tools source gets the token in each
 * tool's `execute`. The Connections are opened side by side, so a slow one holds up no other. A
 * server that is down or refuses the token (HTTP 401), or a Connection the hook gives no token for,
 * is skipped. Each tool is named `<key>_<tool>`, filtered by the Connection's `mcp.tools`
 * allowlist, and needs approval unless its `approvalFree` lists it. Each tool's `metadata.readOnly`
 * says whether a read-only run may call it: an MCP server marks it `readOnlyHint: true`, or
 * `readOnlyTools` names it. A Host tool's `metadata.hostTool` says only its
 * `ConnectionBrokenError` asks for a reconnect.
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
      if (server.tools) {
        const tokenNow = () => accessTokenFor(deps, hook, userId, server.key);
        return hostTools(server, server.tools, tokenNow, signal);
      }
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

/**
 * A Connection's Host tools as server tools named `<key>_<tool>`, their input and result checked
 * against the tool's schemas. Each call asks `tokenNow` for the token, so one the Host refreshed
 * since the tools were listed is the one used, and none means the Connection is broken. A call
 * stops when the Turn's `signal` or the call's own aborts.
 */
function hostTools(
  connection: Pick<McpConnection, "key" | "approvalFree" | "readOnlyTools">,
  tools: readonly HostTool[],
  tokenNow: () => Promise<string | null>,
  signal: AbortSignal,
): AnyServerTool[] {
  return tools.map((tool) =>
    toolDefinition({
      name: `${connection.key}_${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      needsApproval: !(connection.approvalFree ?? []).includes(tool.name),
      metadata: { readOnly: (connection.readOnlyTools ?? []).includes(tool.name), hostTool: true },
    }).server(async (args, context) => {
      const input = await checked(tool.inputSchema, args, "Its input");
      const accessToken = await tokenNow();
      if (!accessToken) throw new ConnectionBrokenError("The Host gave no token");
      const stop = context?.abortSignal ? AbortSignal.any([signal, context.abortSignal]) : signal;
      const result = await tool.execute(input, { accessToken, signal: stop });
      return checked(tool.outputSchema, result, "Its result");
    }),
  );
}

/** `value` as `schema` parses it, when it is a Standard Schema; else `value` unchecked. */
async function checked(schema: SchemaInput, value: unknown, what: string): Promise<unknown> {
  const parsed = await validateWithStandardSchema<unknown>(schema, value);
  if (parsed.success) return parsed.data;
  const issues = parsed.issues.map((issue) =>
    issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
  throw new Error(`${what} doesn't match the tool's schema: ${issues.join("; ")}`);
}
