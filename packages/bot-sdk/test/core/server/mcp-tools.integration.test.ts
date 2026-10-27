import { describe, expect, it, vi } from "vitest";

import { listConnections, readTokens, saveTokens } from "../../../plugins/mcp/server/connections";
import { enabledFeatures } from "@botsdk/bot/feature";
import { mcp, type McpApi } from "../../../plugins/mcp/server/plugin";
import type { McpServerConfig } from "../../../plugins/mcp/server/servers";
import { createTestSdk, type TestDeps } from "../../support/deps";
import { createFakeMcpAuth, fakeMcpResource } from "../../support/fake-mcp-auth";
import { createFakeMcpServer, type FakeMcpTool } from "../../support/fake-mcp-server";
import { createTestChat } from "../../support/sdk";
import { insertUser, type TestUser } from "../../support/users";

vi.setConfig({ testTimeout: 30_000 });

const basePath = "http://localhost/api/chat";
const clientId = "ai-chat-test";
const clientSecret = "test-client-secret";

const linear: McpServerConfig = {
  key: "linear",
  name: "Linear",
  url: fakeMcpResource,
  oauth: { clientId, clientSecret },
};

/** A second server that never answers: its endpoint is down for good. */
const sentry: McpServerConfig = {
  key: "sentry",
  name: "Sentry",
  url: "https://sentry.test/mcp",
  oauth: { clientId, clientSecret },
};

const issueTools: FakeMcpTool[] = [
  { name: "list_issues" },
  { name: "create_issue" },
  { name: "delete_issue", annotations: { readOnlyHint: true } },
];

const mcpOrigin = new URL(fakeMcpResource).origin;

/**
 * A signed-in user with a Linear Connection made through the plugin's OAuth routes, over a fake MCP
 * server and authorization server behind one injected `fetch`.
 */
async function setup({ servers = [linear] }: { servers?: McpServerConfig[] } = {}) {
  const user: TestUser = await insertUser();
  const auth = createFakeMcpAuth({ clientId, clientSecret });
  const server = createFakeMcpServer({ auth, tools: issueTools });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === new URL(sentry.url).origin) {
      return Promise.resolve(new Response("Service unavailable", { status: 503 }));
    }
    // The MCP endpoint is the MCP server's; its `.well-known` discovery documents are the auth server's.
    const isEndpoint = url.origin === mcpOrigin && url.pathname === "/mcp";
    return (isEndpoint ? server.fetch : auth.fetch)(input, init);
  }) as typeof globalThis.fetch;
  const deps = createTestSdk({ fetch, features: [mcp({ servers })] });
  await connect(user, deps, auth);
  const tools = (signal: AbortSignal) => mcpApi(deps).forUser(user.id).tools({ signal });
  return { user, deps, auth, server, tools };
}

/** The mcp feature's API, as the instance serves it as `sdk.mcp`. */
function mcpApi(deps: TestDeps): McpApi {
  const { feature, context } = enabledFeatures(deps).find(({ feature }) => feature.id === "mcp")!;
  return feature.api!(context) as McpApi;
}

/** Signs `user` in to the Linear server through the plugin's OAuth routes (the redirect and callback). */
async function connect(user: TestUser, deps: TestDeps, auth: ReturnType<typeof createFakeMcpAuth>) {
  const client = createTestChat({ user, deps });
  const start = await client.fetch(
    new Request(`${basePath}/mcp/connect?server=linear&returnTo=/settings/keys`, {
      redirect: "manual",
    }),
  );
  await client.fetch(
    new Request(auth.approve(start.headers.get("location") ?? ""), { redirect: "manual" }),
  );
}

/** Saves an expired access token for Linear, keeping the stored refresh token. */
async function expire(deps: TestDeps, userId: string) {
  const stored = await readTokens(deps, userId, "linear");
  await saveTokens(deps, userId, "linear", {
    accessToken: "stale-access-token",
    tokenType: "Bearer",
    refreshToken: stored?.tokens.refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    scope: stored?.scope ?? "",
  });
  return stored;
}

describe("mcp's forUser(id).tools()", () => {
  it("returns a connected server's tools under its key, filtered by its allowlist", async () => {
    const { tools } = await setup({
      servers: [{ ...linear, tools: ["list_issues", "create_issue"] }],
    });
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    expect(listed.map((tool) => tool.name)).toEqual(["linear_list_issues", "linear_create_issue"]);
  });

  it("marks every tool as needing approval except those approvalFree lists", async () => {
    const { tools } = await setup({ servers: [{ ...linear, approvalFree: ["list_issues"] }] });
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    expect(listed.map((tool) => [tool.name, tool.needsApproval === true])).toEqual([
      ["linear_list_issues", false],
      ["linear_create_issue", true],
      ["linear_delete_issue", true],
    ]);
  });

  it("runs a tool on the server", async () => {
    const { server, tools } = await setup();
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    await listed.find((tool) => tool.name === "linear_create_issue")!.execute?.({ title: "Bug" });
    controller.abort();

    expect(server.calls).toEqual([{ name: "create_issue", arguments: { title: "Bug" } }]);
  });

  it("returns nothing for a user with no Connection, and opens no client", async () => {
    const { deps, server } = await setup();
    const stranger = await insertUser();
    const controller = new AbortController();
    const before = server.requests;

    const listed = await mcpApi(deps).forUser(stranger.id).tools({ signal: controller.signal });

    expect(listed).toEqual([]);
    expect(server.requests).toBe(before);
  });

  it("refreshes an expired access token first", async () => {
    const { user, deps, auth, tools } = await setup();
    await expire(deps, user.id);
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    expect(listed).toHaveLength(3);
    expect(auth.tokenRequests.some((request) => request.grant_type === "refresh_token")).toBe(true);
    expect((await readTokens(deps, user.id, "linear"))?.tokens.accessToken).not.toBe(
      "stale-access-token",
    );
  });

  it("leaves a server out when it refuses the refresh, and marks its Connection for reconnection", async () => {
    const { user, deps, auth, tools } = await setup();
    const stored = await expire(deps, user.id);
    if (stored?.tokens.refreshToken) auth.revokeRefresh(stored.tokens.refreshToken);
    const controller = new AbortController();

    const listed = await tools(controller.signal);

    expect(listed).toEqual([]);
    expect(await listConnections(deps, [linear], user.id)).toEqual([
      expect.objectContaining({ key: "linear", state: "reconnect" }),
    ]);
  });

  it("skips a server that is down and returns the others' tools", async () => {
    const { user, deps, tools } = await setup({ servers: [sentry, linear] });
    await saveTokens(deps, user.id, "sentry", {
      accessToken: "sentry-token",
      tokenType: "Bearer",
      scope: "",
    });
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    expect(listed.map((tool) => tool.name)).toEqual([
      "linear_list_issues",
      "linear_create_issue",
      "linear_delete_issue",
    ]);
  });

  it("closes its clients when the signal aborts", async () => {
    const { server, tools } = await setup();
    const controller = new AbortController();
    await tools(controller.signal);
    expect(server.closed).toBe(0);

    controller.abort();

    await expect.poll(() => server.closed, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  it("closes a client whose tool list fails at once, without waiting for the signal", async () => {
    const { server, tools } = await setup();
    server.failList = true;

    const listed = await tools(new AbortController().signal);

    expect(listed).toEqual([]);
    await expect.poll(() => server.closed, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  it("opens nothing on a signal that has already aborted", async () => {
    const { server, tools } = await setup();
    const before = server.requests;

    const listed = await tools(AbortSignal.abort());

    expect(listed).toEqual([]);
    expect(server.requests).toBe(before);
  });
});
