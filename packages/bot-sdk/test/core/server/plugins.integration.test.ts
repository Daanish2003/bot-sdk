import { oc, type } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createHttpHandler } from "../../../core/http";
import { buildBotSdk, createBotSdk } from "../../../core/server/create-chat";
import { defineFeature } from "../../../core/server/feature";
import type { BotSdkPlugin } from "../../../core/server/plugin";
import { memoryRuntime } from "../../../core/server/runtime";
import { models } from "../../../plugins/models/server/internal";
import { testDatabaseUrl } from "../../support/test-database";

const basePath = "/api/chat";
const core = {
  databaseUrl: testDatabaseUrl,
  keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
  models: {},
};

describe("createBotSdk features", () => {
  it("throws when a feature's API has no method for a procedure of its contract", () => {
    const contract = {
      ping: oc.output(type<string>()),
      nested: { pong: oc.output(type<string>()) },
    };
    expect(() =>
      createBotSdk({
        ...core,
        features: [
          // @ts-expect-error the API leaves out nested.pong, which the contract names.
          defineFeature({ id: "first", contract, api: () => ({ ping: () => "ok", nested: {} }) }),
        ],
      }),
    ).toThrow('Feature "first" has no API method for its procedure nested.pong');
  });

  it("serves a contract procedure whose API method is a class's", async () => {
    class Notes {
      count({ userId }: { userId: string }) {
        return `3 for ${userId}`;
      }
    }
    const sdk = createBotSdk({
      ...core,
      features: [
        defineFeature({
          id: "notes",
          contract: { count: oc.output(type<string>()) },
          api: () => new Notes(),
        }),
      ],
    });
    const response = await createHttpHandler(sdk, { basePath, getUser: () => ({ id: "user" }) })(
      new Request(`http://localhost${basePath}/rpc/notes/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(await response.json()).toEqual({ json: "3 for user" });
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

  it("serves each feature's contract under <basePath>/rpc/<id>, calling its API with the user's id", async () => {
    const contract = {
      greeting: { hello: oc.input(z.object({ name: z.string() })).output(type<string>()) },
    };
    const sdk = createBotSdk({
      ...core,
      features: [
        defineFeature({
          id: "first",
          contract,
          api: () => ({
            greeting: {
              hello: ({ name, userId }: { name: string; userId: string }) =>
                `hi ${name} from ${userId}`,
            },
          }),
        }),
      ],
    });

    const response = await createHttpHandler(sdk, { basePath, getUser: () => ({ id: "user" }) })(
      new Request(`http://localhost${basePath}/rpc/first/greeting/hello`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { name: "Ada" } }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: "hi Ada from user" });
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

  it("throws when the core's parts don't start with Models, which the others' inits read", () => {
    const part: BotSdkPlugin = { id: "a" };
    expect(() => buildBotSdk(core, {}, [part, models()])).toThrow(/start with Models/);
  });

  it("types hooks and the HTTP layer's rateLimits by the core", () => {
    const sdk = createBotSdk({
      ...core,
      hooks: {
        onUsage: () => {},
        // @ts-expect-error onNothing is no event of the core's.
        onNothing: () => {},
      },
    });
    expect(() =>
      createHttpHandler(sdk, {
        basePath,
        getUser: () => null,
        rateLimits: {
          credentialSave: false,
          // @ts-expect-error nothing is no rule of the core's.
          nothing: false,
        },
      }),
    ).not.toThrow();
  });
});
