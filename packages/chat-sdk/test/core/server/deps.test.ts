import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkCredentials } from "../../../core/server/credentials/check";
import { createAppDeps } from "../../../core/server/deps";
import { ollamaModels } from "../../../core/server/chat/live-models";
import { memoryRuntime } from "../../../core/server/runtime";
import { BlockedAddressError } from "../../../core/server/lib/guarded-fetch";
import type { Database } from "../../../core/server/db";
import { resolveRateLimits } from "../../../core/server/rate-limits";

function buildDeps() {
  return createAppDeps({
    db: {} as Database,
    keyEncryptionSecrets: ["test-secret"],
    runtime: memoryRuntime(),
    hostProviders: [],
    hostTools: [],
    tools: [],
    byok: true,
    getQuota: async () => null,
    rateLimits: resolveRateLimits(),
    mcpServers: [],
  });
}

describe("createAppDeps", () => {
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
      const deps = buildDeps();

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
