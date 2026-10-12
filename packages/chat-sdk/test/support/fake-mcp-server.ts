import type { FakeMcpAuth } from "./fake-mcp-auth";
import { fakeMcpResource } from "./fake-mcp-auth";

/**
 * A fake MCP server at `fakeMcpResource`, served through an injected `fetch` (never the network).
 * It speaks the Streamable HTTP transport's JSON side: one JSON-RPC message per POST, answered with
 * JSON. It accepts only the access tokens its authorization server issued (`auth.accepts`).
 */
export type FakeMcpTool = {
  name: string;
  annotations?: Record<string, unknown>;
};

export type FakeMcpServer = {
  fetch: typeof globalThis.fetch;
  /** Requests to the endpoint, any method, so a test can see that no client connected. */
  requests: number;
  /** Tool calls that reached the server, in order. A denied call never lands here. */
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Sessions the client closed (`DELETE`). */
  closed: number;
  /** When set, the server is down: every request gets a 503. */
  down: boolean;
  /** When set, `tools/call` fails with a server error. */
  failCalls: boolean;
};

export function createFakeMcpServer({
  auth,
  tools,
  resource = fakeMcpResource,
}: {
  auth: FakeMcpAuth;
  tools: FakeMcpTool[];
  /** The endpoint's URL: the unit tests' default, or a localhost one for the end-to-end tests. */
  resource?: string;
}): FakeMcpServer {
  const mcpOrigin = new URL(resource).origin;
  const mcpPath = new URL(resource).pathname;
  const server: FakeMcpServer = {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== mcpOrigin || url.pathname !== mcpPath) {
        return new Response("Not found", { status: 404 });
      }
      server.requests += 1;
      if (server.down) return new Response("Service unavailable", { status: 503 });
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!auth.accepts(token)) return new Response("Unauthorized", { status: 401 });
      if (request.method === "GET") {
        // The client's server-to-client stream stays open until the client closes it: that abort is
        // the close the fake counts, since the SDK's `close` sends no DELETE.
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                "abort",
                () => {
                  server.closed += 1;
                  try {
                    controller.close();
                  } catch {
                    // Already closed.
                  }
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "DELETE") {
        server.closed += 1;
        return new Response(null, { status: 200 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });

      const message = (await request.json()) as {
        id?: number | string;
        method?: string;
        params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
      };
      // A notification has no id and gets no body back.
      if (message.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) =>
        Response.json(
          { jsonrpc: "2.0", id: message.id, result },
          { headers: { "mcp-session-id": "fake-session" } },
        );
      switch (message.method) {
        case "initialize":
          return reply({
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake-linear", version: "1.0.0" },
          });
        case "tools/list":
          return reply({
            tools: tools.map(({ name, annotations }) => ({
              name,
              description: `The fake ${name} tool.`,
              inputSchema: { type: "object", properties: {} },
              ...(annotations ? { annotations } : {}),
            })),
          });
        case "tools/call": {
          if (server.failCalls) {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "upstream failure" },
            });
          }
          const name = message.params?.name ?? "";
          const args = message.params?.arguments ?? {};
          server.calls.push({ name, arguments: args });
          return reply({
            content: [{ type: "text", text: JSON.stringify({ ran: name, arguments: args }) }],
          });
        }
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
      }
    },
    requests: 0,
    calls: [],
    closed: 0,
    down: false,
    failCalls: false,
  };
  return server;
}
