import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkCredentials,
  ollamaModels,
  productionDeps,
} from "../../../plugins/models/server/internal";
import { buildBotSdk } from "../../../core/server/create-chat";
import type { BotSdkContext } from "../../../core/server/plugin";
import { BlockedAddressError } from "../../../core/server/lib/guarded-fetch";

/** The core context of a real instance. Nothing connects. */
function buildDeps(): BotSdkContext {
  return buildBotSdk(
    {
      databaseUrl: "postgresql://unused@127.0.0.1:9/unused",
      keyEncryptionSecrets: ["test-secret"],
      logger: { error: () => {} },
      models: {},
    },
    {},
  ).context;
}

/** The models plugin's production bundle, over a real core context. */
function buildModelsDeps() {
  return productionDeps(buildDeps(), {});
}

describe("the core context", () => {
  it("builds the bundle's fetch with the SSRF guard", async () => {
    const deps = buildDeps();

    await expect(deps.fetch("http://127.0.0.1:9/")).rejects.toBeInstanceOf(BlockedAddressError);
  });

  describe("with a local Ollama host", () => {
    let server: Server;
    let host: string;

    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/api/tags") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("lets the Ollama credential check and live list reach the user's own host", async () => {
      const deps = buildModelsDeps();

      await expect(checkCredentials("ollama", { host }, deps.ollamaFetch)).resolves.toEqual({
        status: "verified",
      });
      await expect(ollamaModels(deps.ollamaFetch, host)).resolves.toEqual([
        expect.objectContaining({ id: "ollama:qwen3:8b" }),
      ]);
    });

    it("keeps the guard on every other fetch to a private address", async () => {
      const deps = buildDeps();

      await expect(deps.fetch(`${host}/api/tags`)).rejects.toBeInstanceOf(BlockedAddressError);
    });
  });
});
