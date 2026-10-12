import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createChat, type CreateChatOptions } from "../../../core/server/create-chat";
import { deleteUserData } from "../../../core/server/delete-user";
import { mcpConnection } from "../../../core/server/db/schema/connection";
import type { McpServerConfig } from "../../../core/server/mcp/servers";
import { createTestDeps, testKeyEncryptionSecret } from "../../support/deps";
import { createFakeMcpAuth, fakeMcpResource } from "../../support/fake-mcp-auth";
import { createTestChat } from "../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

const clientId = "ai-chat-test";
const clientSecret = "test-client-secret";
const linear: McpServerConfig = {
  key: "linear",
  name: "Linear",
  url: fakeMcpResource,
  oauth: { clientId, clientSecret },
};
const origin = "http://localhost/api/chat";

/** Deps with the fake authorization server behind the injected `fetch`. */
function depsWith(
  auth: ReturnType<typeof createFakeMcpAuth>,
  options: { mcpServers?: McpServerConfig[]; keyEncryptionSecrets?: string[] } = {},
) {
  return createTestDeps({
    fetch: auth.fetch,
    mcpServers: options.mcpServers ?? [linear],
    ...(options.keyEncryptionSecrets ? { keyEncryptionSecrets: options.keyEncryptionSecrets } : {}),
  });
}

const freshAuth = () => createFakeMcpAuth({ clientId, clientSecret });

/** Starts a sign-in as `user` and returns the server's authorize URL (the redirect's Location). */
async function startConnect(user: TestUser, deps: ReturnType<typeof depsWith>) {
  const response = await createTestChat({ user, deps }).fetch(
    new Request(`${origin}/mcp/connect?server=linear&returnTo=/settings/keys`, {
      redirect: "manual",
    }),
  );
  return response;
}

describe("createChat's mcpServers", () => {
  it("refuses a server URL that isn't HTTPS", () => {
    const options: CreateChatOptions = {
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKeyEncryptionSecret],
      basePath: "/api/chat",
      mcpServers: [{ ...linear, url: "http://mcp.test/mcp" }],
    };

    expect(() => createChat(options)).toThrow(/HTTPS/);
  });
});

describe("connecting an MCP server", () => {
  it("redirects to the authorize endpoint with PKCE and the pre-registered client", async () => {
    const auth = freshAuth();
    const user = await insertUser();

    const response = await startConnect(user, depsWith(auth));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://auth.test/authorize");
    expect(location.searchParams.get("client_id")).toBe(clientId);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/mcp/callback`);
    expect(location.searchParams.get("resource")).toBe(fakeMcpResource);
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("exchanges the code, stores the Connection and redirects back to the keys page", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });

    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    const callback = await client.fetch(
      new Request(auth.approve(authorize), { redirect: "manual" }),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings/keys");
    expect(auth.tokenRequests).toHaveLength(1);
    expect(auth.tokenRequests[0]?.grant_type).toBe("authorization_code");
    expect(auth.tokenRequests[0]?.code_verifier).toBeTruthy();

    const { servers } = await client.rpc.connections.list();
    expect(servers).toEqual([
      {
        key: "linear",
        name: "Linear",
        state: "connected",
        scopes: ["read:issues", "write:issues"],
      },
    ]);
  });

  it("stores the tokens encrypted, and no RPC response carries them", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });
    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    await client.fetch(new Request(auth.approve(authorize), { redirect: "manual" }));

    const [row] = await getTestDb()
      .select()
      .from(mcpConnection)
      .where(and(eq(mcpConnection.userId, user.id), eq(mcpConnection.serverKey, "linear")));
    const sent = JSON.stringify(await client.rpc.connections.list());
    const tokenRequest = auth.tokenRequests[0];

    expect(row?.encrypted).toMatch(/^v2\./);
    expect(row?.encrypted).not.toContain("access-token");
    expect(row?.encrypted).not.toContain("refresh-token");
    expect(sent).not.toContain("access-token");
    expect(sent).not.toContain("refresh-token");
    expect(tokenRequest).toBeDefined();
  });

  it("refuses a callback whose state is wrong", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });
    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    const genuine = new URL(auth.approve(authorize));
    genuine.searchParams.set("state", "not-the-state-we-sent");

    const response = await client.fetch(new Request(genuine, { redirect: "manual" }));

    expect(response.status).toBe(400);
    expect(auth.tokenRequests).toHaveLength(0);
  });

  it("refuses a replayed callback", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });
    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    const callbackUrl = auth.approve(authorize);
    await client.fetch(new Request(callbackUrl, { redirect: "manual" }));

    const replay = await client.fetch(new Request(callbackUrl, { redirect: "manual" }));

    expect(replay.status).toBe(400);
    expect(auth.tokenRequests).toHaveLength(1);
  });

  it("refuses connect for a server the Host doesn't list, and with no mcpServers at all", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const none = depsWith(auth, { mcpServers: [] });

    const response = await createTestChat({ user, deps: none }).fetch(
      new Request(`${origin}/mcp/connect?server=linear`, { redirect: "manual" }),
    );

    expect(response.status).toBe(404);
  });

  it("lists nothing when the Host lists no servers", async () => {
    const user = await insertUser();

    const { servers } = await createTestChat({
      user,
      deps: depsWith(freshAuth(), { mcpServers: [] }),
    }).rpc.connections.list();

    expect(servers).toEqual([]);
  });
});

describe("disconnecting and reconnecting", () => {
  it("disconnect removes the Connection", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });
    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    await client.fetch(new Request(auth.approve(authorize), { redirect: "manual" }));

    await client.rpc.connections.disconnect({ key: "linear" });

    const { servers } = await client.rpc.connections.list();
    expect(servers).toEqual([{ key: "linear", name: "Linear", state: "disconnected", scopes: [] }]);
  });

  it("a row that no longer decrypts lists as reconnect needed", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });
    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    await client.fetch(new Request(auth.approve(authorize), { redirect: "manual" }));

    // The same database under a keyring that no longer holds the key the row was written with.
    const rotated = depsWith(auth, { keyEncryptionSecrets: ["a-different-secret-entirely"] });
    const { servers } = await createTestChat({ user, deps: rotated }).rpc.connections.list();

    expect(servers).toEqual([
      {
        key: "linear",
        name: "Linear",
        state: "reconnect",
        scopes: ["read:issues", "write:issues"],
      },
    ]);
  });
});

describe("deleteUser", () => {
  it("removes the user's Connections", async () => {
    const auth = freshAuth();
    const user = await insertUser();
    const deps = depsWith(auth);
    const client = createTestChat({ user, deps });
    const authorize = (await startConnect(user, deps)).headers.get("location") ?? "";
    await client.fetch(new Request(auth.approve(authorize), { redirect: "manual" }));

    await deleteUserData(deps, user.id);

    const rows = await getTestDb()
      .select()
      .from(mcpConnection)
      .where(eq(mcpConnection.userId, user.id));
    expect(rows).toEqual([]);
  });
});
