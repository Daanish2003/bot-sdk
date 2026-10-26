import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpHandler, toNodeHandler, type HttpHandler } from "../../../core/http";
import { createBotSdk } from "../../../core/server/create-chat";
import { createChatHandler } from "../../../core/server/over";
import { hintChanged } from "../../../plugins/bot/server/conversation";
import { insertConversation } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";

const basePath = "/api/chat";
const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];

const rpcCall = (origin: string, route: string) =>
  new Request(`${origin}${basePath}/rpc/${route}`, { method: "POST", body: "{}" });

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The stream ended before an event");
    buffer += decoder.decode(value, { stream: true });
    const match = /data: (.*)\n\n/.exec(buffer);
    if (match) return JSON.parse(match[1]!);
  }
}

describe("createHttpHandler", { timeout: 30_000 }, () => {
  it("answers 401 to an RPC call and a route when getUser returns null", async () => {
    const sdk = createBotSdk({ databaseUrl: testDatabaseUrl, keyEncryptionSecrets, models: {} });
    const http = createHttpHandler(sdk, { basePath, getUser: () => null });

    const rpc = await http(rpcCall("http://localhost", "bot/list"));
    const route = await http(new Request(`http://localhost${basePath}/export`));

    expect([rpc.status, route.status]).toEqual([401, 401]);
    expect(await rpc.json()).toEqual({ code: "error.unauthorized", params: {} });
  });

  it("serves the signed-in user's RPC calls under its basePath, and 404s outside it", async () => {
    const user = await insertUser();
    const sdk = createBotSdk({ databaseUrl: testDatabaseUrl, keyEncryptionSecrets, models: {} });
    const http = createHttpHandler(sdk, { basePath: "/bots/", getUser: () => ({ id: user.id }) });

    const served = await http(
      new Request("http://localhost/bots/rpc/credentials/mode", { method: "POST", body: "{}" }),
    );
    const outside = await http(rpcCall("http://localhost", "credentials/mode"));

    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ json: { byok: true } });
    expect(outside.status).toBe(404);
  });

  it("refuses an instance createBotSdk didn't build", () => {
    expect(() => createHttpHandler({} as never, { basePath, getUser: () => null })).toThrow(
      /createBotSdk/,
    );
  });

  it("applies its rate limits over HTTP and not to in-process calls", async () => {
    const user = await insertUser();
    const sdk = createBotSdk({ databaseUrl: testDatabaseUrl, keyEncryptionSecrets, models: {} });
    const http = createHttpHandler(sdk, {
      basePath,
      getUser: () => ({ id: user.id }),
      rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
    });

    const first = await http(rpcCall("http://localhost", "bot/upload"));
    const limited = await http(rpcCall("http://localhost", "bot/upload"));
    const inProcess = [];
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      inProcess.push(await sdk.bots.upload({ userId: user.id, file: new File(["hi"], name) }));
    }

    expect(first.status).not.toBe(429);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(inProcess.map((file) => file.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("streams a Conversation's change hints as server-sent events", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conversation = await insertConversation(user, { kind: "bot" });
    const http = createChatHandler(deps, { basePath, getUser: () => ({ id: user.id }) });

    const response = await http(
      new Request(`http://localhost${basePath}/events?conversationId=${conversation.id}`),
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    await hintChanged(deps, conversation.id);

    expect(await nextEvent(reader)).toEqual({ type: "changed" });
    await reader.cancel();
  });
});

describe("toNodeHandler", { timeout: 30_000 }, () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = undefined;
  });

  async function serve(http: HttpHandler) {
    server = createServer(toNodeHandler(http));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves the same responses as the fetch handler", async () => {
    const signedIn = await insertUser();
    const deps = createTestSdk();
    const http = createChatHandler(deps, {
      basePath,
      getUser: (request) =>
        request.headers.get("x-user") === signedIn.id ? { id: signedIn.id } : null,
    });
    const origin = await serve(http);
    const signedInCall = (base: string) => {
      const request = rpcCall(base, "credentials/mode");
      request.headers.set("x-user", signedIn.id);
      return request;
    };

    const [direct, overNode] = await Promise.all([
      http(signedInCall("http://localhost")),
      fetch(signedInCall(origin)),
    ]);
    const [directRefusal, nodeRefusal] = await Promise.all([
      http(rpcCall("http://localhost", "bot/list")),
      fetch(rpcCall(origin, "bot/list")),
    ]);

    expect(overNode.status).toBe(direct.status);
    expect(await overNode.json()).toEqual(await direct.json());
    expect(nodeRefusal.status).toBe(401);
    expect(await nodeRefusal.json()).toEqual(await directRefusal.json());
  });

  it("streams change hints over Node", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conversation = await insertConversation(user, { kind: "bot" });
    const origin = await serve(
      createChatHandler(deps, { basePath, getUser: () => ({ id: user.id }) }),
    );

    const response = await fetch(`${origin}${basePath}/events?conversationId=${conversation.id}`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await hintChanged(deps, conversation.id);

    expect(await nextEvent(reader)).toEqual({ type: "changed" });
    await reader.cancel();
  });
});
