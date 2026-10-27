import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHttpHandler,
  createScreenSocket,
  toNodeHandler,
  type HttpHandler,
} from "@botsdk/bot/http";
import { createBotSdk, httpPartsOf } from "@botsdk/bot/create-chat";
import { defineFeature } from "@botsdk/bot/feature";
import { emailChannel } from "@botsdk/bot/channel";
import { fakeEmailProvider } from "../../../plugins/channel/fake/index";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { hintChanged } from "@botsdk/bot/bot/conversation";
import { insertConversation } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";
import { postgres } from "@botsdk/bot/database";

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
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });
    const http = createHttpHandler(sdk, { basePath, getUser: () => null });

    const rpc = await http(rpcCall("http://localhost", "bots/list"));
    const route = await http(new Request(`http://localhost${basePath}/export`));

    expect([rpc.status, route.status]).toEqual([401, 401]);
    expect(await rpc.json()).toEqual({ code: "error.unauthorized", params: {} });
  });

  it("serves the signed-in user's RPC calls under its basePath, and 404s outside it", async () => {
    const user = await insertUser();
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });
    const http = createHttpHandler(sdk, { basePath: "/bots/", getUser: () => ({ id: user.id }) });

    const served = await http(
      new Request("http://localhost/bots/rpc/models/credentials/mode", {
        method: "POST",
        body: "{}",
      }),
    );
    const outside = await http(rpcCall("http://localhost", "models/credentials/mode"));

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
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });
    const http = createHttpHandler(sdk, {
      basePath,
      getUser: () => ({ id: user.id }),
      rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
    });

    const first = await http(rpcCall("http://localhost", "bots/upload"));
    const limited = await http(rpcCall("http://localhost", "bots/upload"));
    const inProcess = [];
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      inProcess.push(await sdk.bots.upload({ userId: user.id, file: new File(["hi"], name) }));
    }

    expect(first.status).not.toBe(429);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(inProcess.map((file) => file.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("serves the webhook, email inbound and Screen routes under its basePath without a user", async () => {
    const email = fakeEmailProvider();
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
      channels: [emailChannel({ provider: email.provider, domain: "bots.example", appUrl: "" })],
    });
    const getUser = vi.fn(() => null);
    const http = createHttpHandler(sdk, { basePath, getUser });
    const post = (path: string, body: string) =>
      http(new Request(`http://localhost${basePath}${path}`, { method: "POST", body }));

    const webhook = await post("/routines/webhook/not-a-token", "{}");
    const mail = await http(
      new Request(`http://localhost${basePath}/channels/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await email.request({ from: "x@example.com", to: ["nobody@bots.example"] }).text(),
      }),
    );
    const unreadable = await post("/channels/email", "not json");
    const screen = await http(new Request(`http://localhost${basePath}/screens/forged/vnc.html`));
    const screenHead = await http(
      new Request(`http://localhost${basePath}/screens/forged/vnc.html`, { method: "HEAD" }),
    );

    expect([webhook.status, mail.status, unreadable.status]).toEqual([404, 202, 400]);
    expect([screen.status, screenHead.status]).toEqual([403, 403]);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("answers email inbound 404 without an email adapter, and asks no user", async () => {
    const getUser = vi.fn(() => null);
    const inbound = (channels?: []) =>
      createHttpHandler(
        createBotSdk({
          database: postgres({ connectionString: testDatabaseUrl }),
          keyEncryptionSecrets,
          models: {},
          channels,
        }),
        { basePath, getUser },
      )(new Request(`http://localhost${basePath}/channels/email`, { method: "POST", body: "{}" }));

    // No channels slot, and a channels slot with no email adapter.
    const answers = await Promise.all([inbound(), inbound([])]);

    expect(answers.map((answer) => answer.status)).toEqual([404, 404]);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("answers 405 with Allow to a public path called with another method, and asks no user", async () => {
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });
    const getUser = vi.fn(() => null);
    const http = createHttpHandler(sdk, { basePath, getUser });
    const call = (method: string, path: string) =>
      http(new Request(`http://localhost${basePath}${path}`, { method }));

    const answers = await Promise.all([
      call("GET", "/routines/webhook/a-token"),
      call("GET", "/channels/email"),
      call("POST", "/screens/forged/vnc.html"),
      call("DELETE", "/screens/forged/websockify"),
    ]);

    expect(answers.map((answer) => [answer.status, answer.headers.get("Allow")])).toEqual([
      [405, "POST"],
      [405, "POST"],
      [405, "GET, HEAD"],
      [405, "GET, HEAD"],
    ]);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("still serves a signed-in route at a public path with its own method", async () => {
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
      features: [
        defineFeature({
          id: "webhook-status",
          routes: [
            {
              method: "GET",
              path: "/routines/webhook/:token",
              handle: async (_request, { user }) => new Response(user.id),
            },
          ],
        }),
      ],
    });
    const http = createHttpHandler(sdk, { basePath, getUser: () => ({ id: "user-1" }) });
    const call = (method: string) =>
      http(new Request(`http://localhost${basePath}/routines/webhook/a-token`, { method }));

    const served = await call("GET");
    const refused = await call("HEAD");

    expect([served.status, await served.text()]).toEqual([200, "user-1"]);
    expect([refused.status, refused.headers.get("Allow")]).toEqual([405, "POST, GET"]);
  });

  it("serves one instance at two basePaths, and the live view's links point under the first", async () => {
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
    });
    const first = createHttpHandler(sdk, { basePath, getUser: () => null });
    const second = createHttpHandler(sdk, { basePath: "/bots/", getUser: () => null });
    createScreenSocket(sdk, { basePath: "/bots" });
    const screen = (http: HttpHandler, at: string) =>
      http(new Request(`http://localhost${at}/screens/forged/vnc.html`));

    expect([
      (await screen(first, basePath)).status,
      (await screen(second, "/bots")).status,
    ]).toEqual([403, 403]);
    expect(httpPartsOf(sdk).context.liveView.base).toBe(basePath);
  });

  it("keeps createBotSdk's liveViewBase as the live view's link base", () => {
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets,
      models: {},
      liveViewBase: "/chat/",
    });
    createHttpHandler(sdk, { basePath, getUser: () => null });

    expect(httpPartsOf(sdk).context.liveView.base).toBe("/chat");
    expect(() =>
      createBotSdk({
        database: postgres({ connectionString: testDatabaseUrl }),
        keyEncryptionSecrets,
        models: {},
        liveViewBase: "chat",
      }),
    ).toThrow('basePath must start with "/"');
  });

  it("streams a Conversation's change hints as server-sent events", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conversation = await insertConversation(user, { kind: "bot" });
    const http = createHttpHandlerOver(deps, { basePath, getUser: () => ({ id: user.id }) });

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
    const http = createHttpHandlerOver(deps, {
      basePath,
      getUser: (request) =>
        request.headers.get("x-user") === signedIn.id ? { id: signedIn.id } : null,
    });
    const origin = await serve(http);
    const signedInCall = (base: string) => {
      const request = rpcCall(base, "models/credentials/mode");
      request.headers.set("x-user", signedIn.id);
      return request;
    };

    const [direct, overNode] = await Promise.all([
      http(signedInCall("http://localhost")),
      fetch(signedInCall(origin)),
    ]);
    const [directRefusal, nodeRefusal] = await Promise.all([
      http(rpcCall("http://localhost", "bots/list")),
      fetch(rpcCall(origin, "bots/list")),
    ]);

    expect(overNode.status).toBe(direct.status);
    expect(await overNode.json()).toEqual(await direct.json());
    expect(nodeRefusal.status).toBe(401);
    expect(await nodeRefusal.json()).toEqual(await directRefusal.json());
  });

  it("answers 500 when the handler throws, and the server keeps serving", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const origin = await serve(async () => {
      calls += 1;
      if (calls === 1) throw new Error("auth is down");
      return new Response("ok");
    });

    const failed = await fetch(`${origin}/anything`);
    const next = await fetch(`${origin}/anything`);

    expect([failed.status, next.status]).toEqual([500, 200]);
    expect(error).toHaveBeenCalledWith(new Error("auth is down"));
    error.mockRestore();
  });

  it("streams change hints over Node", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conversation = await insertConversation(user, { kind: "bot" });
    const origin = await serve(
      createHttpHandlerOver(deps, { basePath, getUser: () => ({ id: user.id }) }),
    );

    const response = await fetch(`${origin}${basePath}/events?conversationId=${conversation.id}`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await hintChanged(deps, conversation.id);

    expect(await nextEvent(reader)).toEqual({ type: "changed" });
    await reader.cancel();
  });
});
