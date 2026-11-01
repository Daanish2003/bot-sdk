import type { AddressInfo } from "node:net";

import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { noStoreErrors } from "../vite-no-store-errors";

const immutable = "max-age=31536000,immutable";

// Serves a pre-bundled dependency the way Vite does: the long-lived header goes on before the body,
// so a failure while sending (Varlock's leak check, in `res.end`) leaves it on the error response.
const fakeDependency: Plugin = {
  name: "fake-dependency",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/failing-dep.js") {
        res.setHeader("Cache-Control", immutable);
        next(new Error("failed while sending"));
        return;
      }
      if (req.url === "/healthy-dep.js") {
        res.setHeader("Cache-Control", immutable);
        res.end("export {};");
        return;
      }
      next();
    });
  },
};

describe("noStoreErrors", () => {
  let server: ViteDevServer;
  let origin: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      appType: "custom",
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      plugins: [noStoreErrors(), fakeDependency],
    });
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | undefined;
    origin = `http://127.0.0.1:${address?.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("stops a browser caching an error that was going out with the long-lived header", async () => {
    const response = await fetch(`${origin}/failing-dep.js`);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves a healthy response's long-lived header alone", async () => {
    const response = await fetch(`${origin}/healthy-dep.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(immutable);
  });
});
