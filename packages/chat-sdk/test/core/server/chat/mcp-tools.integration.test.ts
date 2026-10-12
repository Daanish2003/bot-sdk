import { storedParts, type StoredPart } from "../../../../core/shared/message-parts";
import { message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { stopRun } from "../../../../core/server/chat/run";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { listConnections, readTokens, saveTokens } from "../../../../core/server/mcp/connections";
import type { McpServerConfig } from "../../../../core/server/mcp/servers";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { createFakeMcpAuth, fakeMcpResource } from "../../../support/fake-mcp-auth";
import { createFakeMcpServer, type FakeMcpTool } from "../../../support/fake-mcp-server";
import { createTestChat, sendAs, chatRpc } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const basePath = "http://localhost/api/chat";
const clientId = "ai-chat-test";
const clientSecret = "test-client-secret";

const linear: McpServerConfig = {
  key: "linear",
  name: "Linear",
  url: fakeMcpResource,
  oauth: { clientId, clientSecret },
};

const issueTools: FakeMcpTool[] = [
  { name: "list_issues" },
  { name: "create_issue" },
  { name: "delete_issue", annotations: { readOnlyHint: true } },
];

const mcpOrigin = new URL(fakeMcpResource).origin;

/** The tool names the adapter was offered on its `n`th model call. */
const offered = (calls: { tools?: Array<{ name: string }> }[], n = 0) =>
  (calls[n]?.tools ?? []).map((tool) => tool.name);

/**
 * A signed-in user with Anthropic credentials, a Linear Connection signed in through the Host's
 * OAuth flow, a fake MCP server and authorization server behind one injected `fetch`, and a fake
 * adapter playing `rounds`.
 */
async function setup({
  rounds,
  servers = [linear],
  mcpToolList = issueTools,
  manual = false,
  deps: overrides = {},
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  servers?: McpServerConfig[];
  mcpToolList?: FakeMcpTool[];
  manual?: boolean;
  deps?: TestDepsOverrides;
}) {
  const user: TestUser = await insertUser();
  const auth = createFakeMcpAuth({ clientId, clientSecret });
  const mcp = createFakeMcpServer({ auth, tools: mcpToolList });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The MCP endpoint is the MCP server's; its `.well-known` discovery documents are the auth server's.
    const isEndpoint = url.origin === mcpOrigin && url.pathname === "/mcp";
    return (isEndpoint ? mcp.fetch : auth.fetch)(input, init);
  }) as typeof globalThis.fetch;
  const fake = createFakeAdapter({ rounds, manual });
  const deps = createTestDeps({
    fetch,
    adapterFor: () => fake.adapter,
    mcpServers: servers,
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await connectLinear(user, deps, auth);

  const send = (
    conversationId: string,
    command: { text?: string; tools?: { connections: string[]; allowedTools: string[] } } = {},
  ) =>
    sendAs(
      new Request(`${basePath}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId,
            parentId: null,
            text: "Make an issue",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  /** Decides the waiting call of `messageId` and resolves once its new Run has ended. */
  const decide = async (messageId: string, approved: boolean) => {
    await chatRpc({ user, deps }).chat.decide({ messageId, approved });
    return join(messageId, user, deps);
  };
  return { user, deps, auth, mcp, fake, send, decide };
}

/** Signs `user` in to the Linear server through the Host's OAuth routes (the redirect and callback). */
async function connectLinear(
  user: TestUser,
  deps: AppDeps,
  auth: ReturnType<typeof createFakeMcpAuth>,
) {
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

/** Joins a Message's Run from its log, and reads the log until it closes. */
async function join(messageId: string, user: TestUser, deps: AppDeps) {
  const response = await sendAs(
    new Request(`${basePath}/run?runId=${messageId}`, { method: "GET" }),
    user,
    deps,
  );
  return response.text();
}

async function replyOf(deps: AppDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.filter((row) => row.role === "assistant").at(-1)!;
}

const mcpCall = (
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  status: "awaiting_approval" | "done" | "denied" | "error" = "awaiting_approval",
): StoredPart =>
  ({ type: "tool_call", toolCallId, name, source: "mcp", args, state: status }) as StoredPart;

describe("MCP tools in a Run", () => {
  it("opens no client and offers no MCP tool while no Connection is switched on", async () => {
    const { user, mcp, fake, send } = await setup({ rounds: [round(text("Hi."))] });
    const conv = await insertConversation(user, { title: "Off" });

    await (await send(conv.id)).text();

    expect(mcp.requests).toBe(0);
    expect(offered(fake.calls)).toEqual([]);
  });

  it("offers a switched-on server's tools under its key, filtered by its allowlist, in that Conversation only", async () => {
    const { user, fake, send } = await setup({
      servers: [{ ...linear, tools: ["list_issues", "create_issue"] }],
      rounds: [round(text("One.")), round(text("Two."))],
    });
    const first = await insertConversation(user, { title: "First" });
    const second = await insertConversation(user, { title: "Second" });

    // The first Message takes the composer's choice.
    await (await send(first.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();
    await (await send(second.id)).text();

    expect(offered(fake.calls, 0)).toEqual(["linear_list_issues", "linear_create_issue"]);
    expect(offered(fake.calls, 1)).toEqual([]);
  });

  it("ends the reply waiting on an MCP tool call, runs it on approve, and never reaches the server on deny", async () => {
    const { user, deps, mcp, fake, send, decide } = await setup({
      rounds: [
        round(toolCall({ id: "call-1", name: "linear_create_issue", input: { title: "Bug" } })),
        round(text("Created.")),
        round(toolCall({ id: "call-2", name: "linear_create_issue", input: { title: "Dup" } })),
        round(text("Not created.")),
      ],
    });
    const conv = await insertConversation(user, { title: "Approval" });
    const tools = { connections: ["linear"], allowedTools: [] };

    await (await send(conv.id, { tools })).text();
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "awaiting_approval",
      parts: storedParts([mcpCall("call-1", "linear_create_issue", { title: "Bug" })]),
    });
    expect(mcp.calls).toEqual([]);

    await decide((await replyOf(deps, conv.id)).id, true);
    // The resumed Run offers the same tools again, so the approved call can run (ADR 0008).
    expect(offered(fake.calls, 1)).toEqual([
      "linear_list_issues",
      "linear_create_issue",
      "linear_delete_issue",
    ]);
    expect(mcp.calls).toEqual([{ name: "create_issue", arguments: { title: "Bug" } }]);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });

    await (await send(conv.id, { text: "Again" })).text();
    await decide((await replyOf(deps, conv.id)).id, false);
    expect(mcp.calls).toHaveLength(1);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-2",
          name: "linear_create_issue",
          source: "mcp",
          args: { title: "Dup" },
          state: "denied",
          result: { error: "User declined tool execution" },
        } as StoredPart,
        { type: "text", text: "Not created." },
      ]),
    });
  });

  it("runs a tool listed in approvalFree without asking, and a read-only annotation does not exempt a tool", async () => {
    const { user, deps, mcp, send } = await setup({
      servers: [{ ...linear, approvalFree: ["list_issues"] }],
      rounds: [
        round(toolCall({ id: "call-1", name: "linear_list_issues", input: {} })),
        round(text("Listed.")),
        round(toolCall({ id: "call-2", name: "linear_delete_issue", input: { id: "1" } })),
      ],
    });
    const conv = await insertConversation(user, { title: "Free" });
    const tools = { connections: ["linear"], allowedTools: [] };

    await (await send(conv.id, { tools })).text();
    expect(mcp.calls).toEqual([{ name: "list_issues", arguments: {} }]);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });

    await (await send(conv.id, { text: "Delete it" })).text();
    expect(mcp.calls).toHaveLength(1);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "awaiting_approval" });
  });

  it("refreshes an expired access token before the call", async () => {
    const { user, deps, auth, mcp, send } = await setup({
      servers: [{ ...linear, approvalFree: ["list_issues"] }],
      rounds: [
        round(toolCall({ id: "call-1", name: "linear_list_issues", input: {} })),
        round(text("Listed.")),
      ],
    });
    const stored = await readTokens(deps, user.id, "linear");
    await saveTokens(deps, user.id, "linear", {
      accessToken: "stale-access-token",
      tokenType: "Bearer",
      refreshToken: stored?.tokens.refreshToken,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scope: stored?.scope ?? "",
    });
    const conv = await insertConversation(user, { title: "Refresh" });

    await (await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();

    expect(auth.tokenRequests.some((request) => request.grant_type === "refresh_token")).toBe(true);
    expect(mcp.calls).toHaveLength(1);
    expect(await listConnections(deps, user.id)).toEqual([
      expect.objectContaining({ key: "linear", state: "connected" }),
    ]);
  });

  it("marks the Connection as needing reconnection when the server refuses the refresh, and runs without its tools", async () => {
    const { user, deps, auth, fake, send } = await setup({
      rounds: [round(text("No tools."))],
    });
    const stored = await readTokens(deps, user.id, "linear");
    if (stored?.tokens.refreshToken) auth.revokeRefresh(stored.tokens.refreshToken);
    await saveTokens(deps, user.id, "linear", {
      accessToken: "stale-access-token",
      tokenType: "Bearer",
      refreshToken: stored?.tokens.refreshToken,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scope: stored?.scope ?? "",
    });
    const conv = await insertConversation(user, { title: "Reconnect" });

    await (await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();

    expect(offered(fake.calls)).toEqual([]);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });
    expect(await listConnections(deps, user.id)).toEqual([
      expect.objectContaining({ key: "linear", state: "reconnect" }),
    ]);
  });

  it("a tool that fails fails only its own call, and the reply completes", async () => {
    const { user, deps, mcp, send } = await setup({
      servers: [{ ...linear, approvalFree: ["list_issues"] }],
      rounds: [
        round(toolCall({ id: "call-1", name: "linear_list_issues", input: {} })),
        round(text("Sorry.")),
      ],
    });
    mcp.failCalls = true;
    const conv = await insertConversation(user, { title: "Failing" });

    await (await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();

    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "linear_list_issues",
          source: "mcp",
          args: {},
          state: "error",
          result: { error: expect.any(String) },
        } as StoredPart,
        { type: "text", text: "Sorry." },
      ]),
    });
  });

  it("a server that is down at the start offers no tools, and the reply completes", async () => {
    const { user, deps, mcp, fake, send } = await setup({ rounds: [round(text("Hi."))] });
    mcp.down = true;
    const conv = await insertConversation(user, { title: "Down" });

    await (await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();

    expect(offered(fake.calls)).toEqual([]);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });
  });

  it("caps the calls of one reply at 10 across Host and MCP tools", async () => {
    const { user, deps, mcp, send } = await setup({
      servers: [{ ...linear, approvalFree: ["list_issues"] }],
      rounds: [
        round(
          ...Array.from({ length: 11 }, (_, index) =>
            toolCall({ id: `call-${index + 1}`, name: "linear_list_issues", input: {} }),
          ),
        ),
        round(text("Done.")),
      ],
    });
    const conv = await insertConversation(user, { title: "Cap" });

    await (await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();

    expect(mcp.calls).toHaveLength(10);
    const reply = await replyOf(deps, conv.id);
    const calls = (reply.parts as { parts: StoredPart[] }).parts.filter(
      (part) => part.type === "tool_call",
    );
    expect(calls).toHaveLength(11);
    expect(calls.at(-1)).toMatchObject({
      state: "error",
      result: { error: "tool call limit reached" },
    });
  });

  it("closes its clients when the Run ends", async () => {
    const { user, mcp, send } = await setup({
      servers: [{ ...linear, approvalFree: ["list_issues"] }],
      rounds: [
        round(toolCall({ id: "call-1", name: "linear_list_issues", input: {} })),
        round(text("Listed.")),
      ],
    });
    const conv = await insertConversation(user, { title: "Close" });

    await (await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } })).text();

    expect(mcp.closed).toBeGreaterThanOrEqual(1);
  });

  it("closes its clients on Stop", async () => {
    const { user, deps, mcp, send } = await setup({
      rounds: [round(text("Never finished."))],
      manual: true,
    });
    const conv = await insertConversation(user, { title: "Stop" });

    const response = await send(conv.id, { tools: { connections: ["linear"], allowedTools: [] } });
    // The clients open before the model is called, so a connected server is seen before the Stop.
    for (let waited = 0; mcp.requests === 0 && waited < 5_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await stopRun(deps, (await replyOf(deps, conv.id)).id);
    await response.text();

    expect(mcp.closed).toBeGreaterThanOrEqual(1);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "stopped" });
  });
});

describe("Allow for this Conversation on an MCP tool", () => {
  it("runs a waiting MCP call on allow, and later calls to that tool in the Conversation run without asking", async () => {
    const { user, deps, mcp, send } = await setup({
      rounds: [
        round(toolCall({ id: "call-1", name: "linear_create_issue", input: { title: "Bug" } })),
        round(text("Created.")),
        round(toolCall({ id: "call-2", name: "linear_create_issue", input: { title: "Second" } })),
        round(text("Created again.")),
      ],
    });
    const conv = await insertConversation(user, { title: "Allow" });
    const tools = { connections: ["linear"], allowedTools: [] };
    await (await send(conv.id, { tools })).text();
    const reply = await replyOf(deps, conv.id);

    await chatRpc({ user, deps }).chat.decide({
      messageId: reply.id,
      approved: true,
      allowForConversation: true,
    });
    await join(reply.id, user, deps);

    expect(mcp.calls).toEqual([{ name: "create_issue", arguments: { title: "Bug" } }]);

    await (await send(conv.id, { text: "Again" })).text();

    expect(mcp.calls).toHaveLength(2);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        expect.objectContaining({ toolCallId: "call-2", state: "done" }),
        { type: "text", text: "Created again." },
      ]),
    });
  });
});
