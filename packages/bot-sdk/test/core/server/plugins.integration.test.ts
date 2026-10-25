import { os } from "@orpc/server";
import { describe, expect, it } from "vitest";

import { buildBotSdk, createBotSdk } from "../../../core/server/create-chat";
import { defineFeature } from "../../../core/server/feature";
import type { BotSdkPlugin } from "../../../core/server/plugin";
import { memoryRuntime } from "../../../core/server/runtime";
import { models } from "../../../plugins/models/server/plugin";
import { testDatabaseUrl } from "../../support/test-database";

const basePath = "/api/chat";
const core = {
  databaseUrl: testDatabaseUrl,
  getUser: () => ({ id: "user" }),
  keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
  basePath,
  models: {},
};

describe("createBotSdk features", () => {
  it("throws when two features claim the same router key", () => {
    const procedure = os.handler(() => "ok");
    expect(() =>
      createBotSdk({
        ...core,
        features: [
          defineFeature({ id: "first", router: { shared: { ping: procedure } } }),
          defineFeature({ id: "second", router: { shared: { pong: procedure } } }),
        ],
      }),
    ).toThrow(/shared.*first.*second/);
  });

  it("throws when a feature claims a core route", () => {
    const route = { method: "GET", path: "/export", handle: async () => new Response() } as const;
    expect(() =>
      createBotSdk({ ...core, features: [defineFeature({ id: "first", routes: [route] })] }),
    ).toThrow(/GET \/export.*core.*first/);
  });

  it("throws when two features claim the same route", () => {
    const route = { method: "GET", path: "/thing", handle: async () => new Response() } as const;
    expect(() =>
      createBotSdk({
        ...core,
        features: [
          defineFeature({ id: "first", routes: [route] }),
          defineFeature({ id: "second", routes: [route] }),
        ],
      }),
    ).toThrow(/GET \/thing.*first.*second/);
  });

  it("serves each feature's router under <basePath>/rpc/<key>", async () => {
    const sdk = createBotSdk({
      ...core,
      features: [
        defineFeature({ id: "first", router: { greeting: { hello: os.handler(() => "hi") } } }),
      ],
    });

    const response = await sdk.handler(
      new Request(`http://localhost${basePath}/rpc/greeting/hello`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: "hi" });
  });

  it("starts the core's parts in order and stops them in reverse", async () => {
    const calls: string[] = [];
    const part = (id: string): BotSdkPlugin => ({
      id,
      start: async () => void calls.push(`start ${id}`),
      stop: async () => void calls.push(`stop ${id}`),
    });
    const sdk = buildBotSdk(core, {}, [models(), part("a"), part("b"), part("c")]).instance;

    await sdk.start();
    await sdk.stop();

    expect(calls).toEqual(["start a", "start b", "start c", "stop c", "stop b", "stop a"]);
  });

  it("stops every part and closes the runtime when one part's stop throws, then rethrows", async () => {
    const calls: string[] = [];
    const part = (id: string, fails = false): BotSdkPlugin => ({
      id,
      stop: async () => {
        calls.push(`stop ${id}`);
        if (fails) throw new Error(`${id} failed`);
      },
    });
    const sdk = buildBotSdk(
      { ...core, pubsub: { ...memoryRuntime(), close: async () => void calls.push("close") } },
      {},
      [models(), part("a"), part("b", true), part("c")],
    ).instance;

    await expect(sdk.stop()).rejects.toThrow("b failed");

    expect(calls).toEqual(["stop c", "stop b", "stop a", "close"]);
  });

  it("types hooks and rateLimits by the core", () => {
    expect(() =>
      createBotSdk({
        ...core,
        hooks: {
          onUsage: () => {},
          // @ts-expect-error onNothing is no event of the core's.
          onNothing: () => {},
        },
        rateLimits: {
          // @ts-expect-error nothing is no rule of the core's.
          nothing: false,
        },
      }),
    ).not.toThrow();
  });
});
