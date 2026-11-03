import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpHandler, toNodeHandler } from "../../src/http";
import { createBotSdk } from "../../src/create-chat";
import { defineFeature } from "../../src/feature";
import { postgres } from "../../src/database";
import { testDatabaseUrl } from "@ai-chat/test-support/test-database";

/*
 * A feature's `publicRoutes` (spec #1167): served with no signed-in user and handed only the
 * feature's own context. The requests are real HTTP, over a Node server, on real Postgres.
 */

const basePath = "/api/chat";
const base = {
  keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
  models: {},
};
const database = () => postgres({ connectionString: testDatabaseUrl });

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

async function serve(features: Parameters<typeof createBotSdk>[0]["features"]) {
  const sdk = createBotSdk({ database: database(), ...base, features });
  const http = createHttpHandler(sdk, { basePath, getUser: () => null });
  server = createServer(toNodeHandler(http));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;
}

describe("a feature's public routes", { timeout: 30_000 }, () => {
  it("answers a request with no signed-in user, and its handler gets only the feature's context", async () => {
    const origin = await serve([
      defineFeature({
        id: "web",
        publicRoutes: [
          {
            method: "POST",
            path: "/web/:slug",
            handle: async (request, args) =>
              Response.json({
                args: Object.keys(args).sort(),
                params: args.params,
                body: await request.text(),
                // A feature's context reaches the database; the core's would hold `sdk.bots` too.
                rows: (await args.context.db.execute("select 1 as one")).rows,
                core: "bots" in args.context,
              }),
          },
        ],
      }),
    ]);

    const response = await fetch(`${origin}/web/hello`, { method: "POST", body: "hi" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      args: ["basePath", "context", "params"],
      params: { slug: "hello" },
      body: "hi",
      rows: [{ one: 1 }],
      core: false,
    });
  });

  it("answers 405 with Allow to another method at a public route's path", async () => {
    const origin = await serve([
      defineFeature({
        id: "web",
        publicRoutes: [{ method: "GET", path: "/web", handle: async () => new Response("ok") }],
      }),
    ]);

    const response = await fetch(`${origin}/web`, { method: "POST" });

    expect([response.status, response.headers.get("Allow")]).toEqual([405, "GET"]);
  });

  it("refuses two routes with the same method and path, public or not", () => {
    const handle = async () => new Response();
    const make = (features: Parameters<typeof createBotSdk>[0]["features"]) => () =>
      createBotSdk({ database: database(), ...base, features });

    expect(
      make([
        defineFeature({ id: "first", publicRoutes: [{ method: "GET", path: "/thing", handle }] }),
        defineFeature({ id: "second", publicRoutes: [{ method: "GET", path: "/thing", handle }] }),
      ]),
    ).toThrow(/GET \/thing.*first.*second/);
    expect(
      make([
        defineFeature({ id: "first", routes: [{ method: "GET", path: "/thing", handle }] }),
        defineFeature({ id: "second", publicRoutes: [{ method: "GET", path: "/thing", handle }] }),
      ]),
    ).toThrow(/GET \/thing.*first.*second/);
  });

  it("leaves a feature's existing routes as they were", async () => {
    const origin = await serve([
      defineFeature({
        id: "legacy",
        routes: [{ method: "GET", path: "/legacy", handle: async () => new Response("signed in") }],
      }),
    ]);

    expect((await fetch(`${origin}/legacy`)).status).toBe(401);
  });
});
