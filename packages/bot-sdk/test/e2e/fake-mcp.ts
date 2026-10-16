/// <reference types="node" />
import { createServer, type Server } from "node:http";

import { createFakeMcpAuth } from "../support/fake-mcp-auth";
import { createFakeMcpServer, type FakeMcpTool } from "../support/fake-mcp-server";

const tools: FakeMcpTool[] = [{ name: "list_issues" }, { name: "create_issue" }];

/**
 * Serves the fake MCP server at `/mcp`, its authorization server's metadata and token endpoint
 * beside it, and the authorize step: the browser is redirected straight back with a code, as a
 * signed-in user who approves would be. Requests are answered by the same fakes the unit tests use.
 */
export function startFakeMcp({
  port,
  clientId,
  clientSecret,
}: {
  port: number;
  clientId: string;
  clientSecret: string;
}): Promise<Server> {
  const origin = `http://localhost:${port}`;
  const auth = createFakeMcpAuth({
    clientId,
    clientSecret,
    resource: `${origin}/mcp`,
    authOrigin: origin,
  });
  const mcp = createFakeMcpServer({ auth, tools, resource: `${origin}/mcp` });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/authorize" && request.method === "GET") {
      response.writeHead(302, { location: auth.approve(url.toString()) });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && name !== "host") headers.set(name, [value].flat().join(", "));
    }
    // A closed connection aborts the request: the MCP fake counts that as the client closing its stream.
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    const fetch = url.pathname === "/mcp" ? mcp.fetch : auth.fetch;
    const reply = await fetch(
      new Request(url, {
        method: request.method,
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        signal: controller.signal,
      }),
    );
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    if (reply.body) {
      for await (const chunk of reply.body) response.write(chunk);
    }
    response.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
