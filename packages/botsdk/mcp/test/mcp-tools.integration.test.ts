import { describe, expect, it, vi } from "vitest";

import { enabledFeatures } from "@botsdk/bot/feature";
import { mcp, type ConnectionAnswer, type McpApi, type McpConnection } from "../src";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import {
  createFakeMcpServer,
  fakeMcpResource,
  type FakeMcpTool,
} from "@ai-chat/test-support/fake-mcp-server";
import { insertUser, type TestUser } from "@ai-chat/test-support/users";

vi.setConfig({ testTimeout: 30_000 });

const token = "linear-access-token";

const linear: McpConnection = { key: "linear", name: "Linear", mcp: { url: fakeMcpResource } };

/** A second Connection whose server never answers: its endpoint is down for good. */
const sentry: McpConnection = {
  key: "sentry",
  name: "Sentry",
  mcp: { url: "https://sentry.test/mcp" },
};

const issueTools: FakeMcpTool[] = [
  { name: "list_issues" },
  { name: "create_issue" },
  { name: "delete_issue", annotations: { readOnlyHint: true } },
];

/**
 * A user whose Host's `connection` hook answers `answers[key]` (a token for every Connection unless
 * given), over a fake MCP server that takes only `token`, behind one injected `fetch`.
 */
async function setup({
  connections = [linear],
  answers = {},
}: {
  connections?: McpConnection[];
  answers?: Record<string, ConnectionAnswer>;
} = {}) {
  const user: TestUser = await insertUser();
  const server = createFakeMcpServer({ accepts: (sent) => sent === token, tools: issueTools });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === new URL(sentry.mcp.url).origin) {
      return Promise.resolve(new Response("Service unavailable", { status: 503 }));
    }
    return server.fetch(input, init);
  }) as typeof globalThis.fetch;
  const asked: Array<[string, string]> = [];
  const deps = createTestSdk({
    fetch,
    features: [
      mcp({
        connections,
        connection: (userId, key) => {
          asked.push([userId, key]);
          if (userId !== user.id) return null;
          return key in answers ? answers[key] : { accessToken: token };
        },
      }),
    ],
  });
  const tools = (signal: AbortSignal) => mcpApi(deps).forUser(user.id).tools({ signal });
  return { user, deps, server, tools, asked };
}

/** The mcp feature's API, as the instance serves it as `sdk.mcp`. */
function mcpApi(deps: TestDeps): McpApi {
  const { feature, context } = enabledFeatures(deps).find(({ feature }) => feature.id === "mcp")!;
  return feature.api!(context) as McpApi;
}

describe("mcp's forUser(id).tools()", () => {
  it("returns a connected server's tools under its key, filtered by its allowlist", async () => {
    const { tools } = await setup({
      connections: [{ ...linear, mcp: { ...linear.mcp, tools: ["list_issues", "create_issue"] } }],
    });
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    expect(listed.map((tool) => tool.name)).toEqual(["linear_list_issues", "linear_create_issue"]);
  });

  it("marks every tool as needing approval except those approvalFree lists", async () => {
    const { tools } = await setup({ connections: [{ ...linear, approvalFree: ["list_issues"] }] });
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    expect(listed.map((tool) => [tool.name, tool.needsApproval === true])).toEqual([
      ["linear_list_issues", false],
      ["linear_create_issue", true],
      ["linear_delete_issue", true],
    ]);
  });

  it("stamps each tool read-only when the server hints it or readOnlyTools names it", async () => {
    const { tools } = await setup({ connections: [{ ...linear, readOnlyTools: ["list_issues"] }] });
    const controller = new AbortController();

    const listed = await tools(controller.signal);
    controller.abort();

    // list_issues is named in readOnlyTools; delete_issue carries readOnlyHint: true; create_issue has neither.
    expect(listed.map((tool) => [tool.name, tool.metadata?.readOnly === true])).toEqual([
      ["linear_list_issues", true],
      ["linear_create_issue", false],
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

  it("returns nothing for a user the hook has no Connection for, and opens no client", async () => {
    const { deps, server } = await setup();
    const stranger = await insertUser();
    const controller = new AbortController();
    const before = server.requests;

    const listed = await mcpApi(deps).forUser(stranger.id).tools({ signal: controller.signal });

    expect(listed).toEqual([]);
    expect(server.requests).toBe(before);
  });

  it.each([
    ["needs reconnecting", { reconnect: true as const }],
    ["isn't linked", null],
  ] as const)(
    "returns nothing, and opens no client, when the hook answers that it %s",
    async (_case, answer) => {
      const { server, tools, asked, user } = await setup({ answers: { linear: answer } });

      const listed = await tools(new AbortController().signal);

      expect(listed).toEqual([]);
      expect(server.requests).toBe(0);
      expect(asked).toEqual([[user.id, "linear"]]);
    },
  );

  it("leaves out a server that refuses the hook's token with HTTP 401", async () => {
    const { server, tools } = await setup({ answers: { linear: { accessToken: "revoked" } } });

    const listed = await tools(new AbortController().signal);

    expect(listed).toEqual([]);
    expect(server.authorizations).toContain("Bearer revoked");
  });

  it("skips a server that is down and returns the others' tools", async () => {
    const { tools } = await setup({ connections: [sentry, linear] });
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

describe("mcp's listConnections", () => {
  it("reports each declared Connection's state from the hook, in the Host's order", async () => {
    const github: McpConnection = { key: "github", name: "GitHub", mcp: { url: fakeMcpResource } };
    const { deps, user } = await setup({
      connections: [github, linear, sentry],
      answers: { github: null, linear: { reconnect: true }, sentry: { accessToken: "t" } },
    });

    expect(await mcpApi(deps).listConnections({ userId: user.id })).toEqual([
      { key: "github", name: "GitHub", state: "disconnected" },
      { key: "linear", name: "Linear", state: "reconnect" },
      { key: "sentry", name: "Sentry", state: "connected" },
    ]);
  });

  it("lists nothing when the Host declares no Connections", async () => {
    const { deps, user } = await setup({ connections: [] });

    expect(await mcpApi(deps).listConnections({ userId: user.id })).toEqual([]);
  });

  it("reports every Connection as not connected without a hook, and one whose hook fails", async () => {
    const user = await insertUser();
    const errors: unknown[] = [];
    const without = createTestSdk({ features: [mcp({ connections: [linear] })] });
    const failing = createTestSdk({
      logger: { error: (...args: unknown[]) => errors.push(args) },
      features: [
        mcp({
          connections: [linear],
          connection: () => {
            throw new Error("Better Auth is down");
          },
        }),
      ],
    });

    for (const deps of [without, failing]) {
      expect(await mcpApi(deps).listConnections({ userId: user.id })).toEqual([
        { key: "linear", name: "Linear", state: "disconnected" },
      ]);
    }
    expect(errors).toHaveLength(1);
  });
});

describe("mcp({ connections })", () => {
  it("refuses a Connection whose server URL isn't HTTPS when the SDK is built", () => {
    const plain = { ...linear, mcp: { url: "http://mcp.example.com/mcp" } };

    expect(() => createTestSdk({ features: [mcp({ connections: [plain] })] })).toThrow(/HTTPS/);
  });
});
