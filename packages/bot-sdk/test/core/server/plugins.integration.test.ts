import { os } from "@orpc/server";
import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import type { BotSdkPlugin } from "../../../core/server/plugin";
import { testDatabaseUrl } from "../../support/test-database";

const basePath = "/api/chat";
const core = {
  databaseUrl: testDatabaseUrl,
  getUser: () => ({ id: "user" }),
  keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
  basePath,
};

describe("createBotSdk plugins", () => {
  it("throws when a plugin's required plugin is missing", () => {
    expect(() =>
      createBotSdk({ ...core, plugins: [{ id: "assistant", requires: ["models"] }] }),
    ).toThrow(/assistant.*models/);
  });

  it("throws when two plugins claim the same router key", () => {
    const procedure = os.handler(() => "ok");
    expect(() =>
      createBotSdk({
        ...core,
        plugins: [
          { id: "first", router: { shared: { ping: procedure } } },
          { id: "second", router: { shared: { pong: procedure } } },
        ],
      }),
    ).toThrow(/shared.*first.*second/);
  });

  it("serves each plugin's router under <basePath>/rpc/<key>", async () => {
    const sdk = createBotSdk({
      ...core,
      plugins: [{ id: "first", router: { greeting: { hello: os.handler(() => "hi") } } }],
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

  it("starts plugins in dependency order and stops them in reverse", async () => {
    const calls: string[] = [];
    const plugin = (id: string, requires: string[] = []): BotSdkPlugin => ({
      id,
      requires,
      start: async () => void calls.push(`start ${id}`),
      stop: async () => void calls.push(`stop ${id}`),
    });
    // Listed before what it requires, so the order comes from `requires`, not the list.
    const sdk = createBotSdk({
      ...core,
      plugins: [plugin("c", ["b"]), plugin("b", ["a"]), plugin("a")],
    });

    await sdk.start();
    await sdk.stop();

    expect(calls).toEqual(["start a", "start b", "start c", "stop c", "stop b", "stop a"]);
  });

  it("gives each plugin the APIs of the plugins it requires", async () => {
    const seen: unknown[] = [];
    const sdk = createBotSdk({
      ...core,
      plugins: [
        {
          id: "reader",
          requires: ["source"],
          start: async (context) => {
            seen.push((context.plugin as (id: string) => unknown)("source"));
          },
        },
        { id: "source", init: () => ({ api: { answer: 42 } }) },
      ],
    });

    await sdk.start();

    expect(seen).toEqual([{ answer: 42 }]);
  });

  it("throws from plugin(id) for a plugin that isn't enabled", () => {
    const sdk = createBotSdk({ ...core, plugins: [{ id: "first" }] });

    expect(() => (sdk.plugin as (id: string) => unknown)("absent")).toThrow(/absent/);
  });

  it("types hooks and rateLimits by the enabled plugins", () => {
    const quiet: BotSdkPlugin<"quiet", "ping", "onUsage"> = {
      id: "quiet",
      rateLimits: { ping: { limit: 1, windowSeconds: 60 } },
    };
    expect(() =>
      createBotSdk({
        ...core,
        plugins: [quiet],
        hooks: {
          onUsage: () => {},
          // @ts-expect-error onRunEnd is no enabled plugin's event.
          onRunEnd: () => {},
        },
        rateLimits: {
          ping: false,
          // @ts-expect-error runStart is no enabled plugin's rule.
          runStart: false,
        },
      }),
    ).not.toThrow();
  });
});
