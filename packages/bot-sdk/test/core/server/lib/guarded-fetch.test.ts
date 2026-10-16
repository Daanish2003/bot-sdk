import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BlockedAddressError,
  createGuardedFetch,
  type GuardedFetchOptions,
} from "../../../../core/server/lib/guarded-fetch";

// Public addresses in the tests are only names. `dial` sends their connections to the local
// server, so nothing here reaches the internet.
const publicAddress = "93.184.216.34";
const dialLocal = (address: string) => (address === publicAddress ? "127.0.0.1" : address);

let server: http.Server;
let port: number;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("served");
  };
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function guard(
  options: Partial<GuardedFetchOptions> & { resolve: GuardedFetchOptions["resolve"] },
) {
  return createGuardedFetch({ schemes: "http-and-https", dial: dialLocal, ...options });
}

// Unwraps `fetch failed` so the guard's own error is what the test asserts.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caught) {
    let error: unknown = caught;
    while (error instanceof Error && !(error instanceof BlockedAddressError) && error.cause) {
      error = error.cause;
    }
    return error;
  }
  throw new Error("expected the fetch to reject");
}

describe("createGuardedFetch", () => {
  describe("refuses private and reserved addresses a name resolves to", () => {
    const refused = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ];

    for (const address of refused) {
      it(`refuses ${address}`, async () => {
        const resolve = vi.fn(async () => [address]);
        const fetch = guard({ resolve });

        const error = await rejectionOf(fetch(`http://evil.test:${port}/`));

        expect(error).toBeInstanceOf(BlockedAddressError);
        expect(resolve).toHaveBeenCalledOnce();
      });
    }

    it("refuses when any one of several addresses is private", async () => {
      const fetch = guard({ resolve: async () => [publicAddress, "10.0.0.7"] });

      const error = await rejectionOf(fetch(`http://mixed.test:${port}/`));

      expect(error).toBeInstanceOf(BlockedAddressError);
    });
  });

  describe("refuses addresses written in odd IPv4 notations or literal form", () => {
    const literals = [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://0x7f.0.0.1/",
      "http://0x7f000001/",
      "http://127.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0xa9fea9fe/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ];

    for (const url of literals) {
      it(`refuses ${url} without a DNS lookup`, async () => {
        const resolve = vi.fn(async () => [publicAddress]);
        const fetch = guard({ resolve });

        const error = await rejectionOf(fetch(url));

        expect(error).toBeInstanceOf(BlockedAddressError);
        expect(resolve).not.toHaveBeenCalled();
      });
    }
  });

  it("fetches at the address it checked, never a second resolution", async () => {
    handler = (_req, res) => res.end("pinned");
    const resolve = vi
      .fn<(hostname: string) => Promise<string[]>>()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const dial = vi.fn(dialLocal);
    const fetch = guard({ resolve, dial });

    const response = await fetch(`http://rebind.test:${port}/`);

    expect(await response.text()).toBe("pinned");
    expect(resolve).toHaveBeenCalledOnce();
    expect(dial).toHaveBeenCalledWith(publicAddress);
    expect(dial).not.toHaveBeenCalledWith("127.0.0.1");
  });

  it("allows HTTP in the HTTP-and-HTTPS mode", async () => {
    const fetch = guard({ resolve: async () => [publicAddress] });

    const response = await fetch(`http://plain.test:${port}/`);

    expect(await response.text()).toBe("served");
  });

  it("refuses HTTP in the HTTPS-only mode, before any lookup", async () => {
    const resolve = vi.fn(async () => [publicAddress]);
    const fetch = guard({ schemes: "https", resolve });

    await expect(fetch(`http://plain.test:${port}/`)).rejects.toThrow(/HTTPS/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("follows a redirect chain of allowed hops", async () => {
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: `http://second.test:${port}/middle` });
        res.end();
      } else if (req.url === "/middle") {
        res.writeHead(301, { location: `http://third.test:${port}/end` });
        res.end();
      } else {
        res.end("arrived");
      }
    };
    const fetch = guard({ resolve: async () => [publicAddress] });

    const response = await fetch(`http://first.test:${port}/start`);

    expect(await response.text()).toBe("arrived");
  });

  it("refuses a redirect to a literal private address", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    };
    const fetch = guard({ resolve: async () => [publicAddress] });

    const error = await rejectionOf(fetch(`http://bounce.test:${port}/`));

    expect(error).toBeInstanceOf(BlockedAddressError);
  });

  it("refuses a redirect to a name that resolves to a private address", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://internal.test:${port}/` });
      res.end();
    };
    const resolve = async (hostname: string) =>
      hostname === "internal.test" ? ["10.0.0.5"] : [publicAddress];
    const fetch = guard({ resolve });

    const error = await rejectionOf(fetch(`http://bounce.test:${port}/`));

    expect(error).toBeInstanceOf(BlockedAddressError);
  });

  it("stops after the redirect limit", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://loop.test:${port}/again` });
      res.end();
    };
    const fetch = guard({ resolve: async () => [publicAddress], maxRedirects: 2 });

    await expect(fetch(`http://loop.test:${port}/`)).rejects.toThrow(/redirect/i);
  });

  // No resolver injected: the system resolver answers `localhost` from the hosts file, offline.
  it("uses the system resolver by default and refuses localhost", async () => {
    const fetch = createGuardedFetch({ schemes: "http-and-https" });

    const error = await rejectionOf(fetch(`http://localhost:${port}/`));

    expect(error).toBeInstanceOf(BlockedAddressError);
  });
});

describe("createGuardedFetch test allowance (allowHosts)", () => {
  it("reaches a listed host at a private address, over plain HTTP", async () => {
    const resolve = vi.fn(async () => ["127.0.0.1"]);
    const fetch = guard({ resolve, dial: (address) => address, allowHosts: ["fake.test"] });

    const response = await fetch(`http://fake.test:${port}/page`);

    expect(await response.text()).toBe("served");
  });

  it("reaches a listed host:port only on that port", async () => {
    const fetch = guard({
      resolve: async () => ["127.0.0.1"],
      dial: (address) => address,
      allowHosts: [`localhost:${port}`],
    });

    expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("served");
    const error = await rejectionOf(fetch(`http://localhost:${port + 1}/`));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/listed ports/);
  });

  it("still refuses a private address whose host is not listed", async () => {
    const fetch = guard({
      resolve: async (hostname) => (hostname === "fake.test" ? ["127.0.0.1"] : ["10.0.0.9"]),
      dial: (address) => address,
      allowHosts: ["fake.test"],
    });

    const error = await rejectionOf(fetch(`http://other.test:${port}/`));

    expect(error).toBeInstanceOf(BlockedAddressError);
  });

  it("still refuses a literal private address, even when another host is listed", async () => {
    const resolve = vi.fn(async () => ["127.0.0.1"]);
    const fetch = guard({ resolve, allowHosts: ["fake.test"] });

    const error = await rejectionOf(fetch(`http://127.0.0.1:${port}/`));

    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a redirect from a listed host to an unlisted private host", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://internal.test:${port}/` });
      res.end();
    };
    const resolve = async (hostname: string) =>
      hostname === "fake.test" ? ["127.0.0.1"] : ["10.0.0.5"];
    const fetch = guard({ resolve, dial: (address) => address, allowHosts: ["fake.test"] });

    const error = await rejectionOf(fetch(`http://fake.test:${port}/`));

    expect(error).toBeInstanceOf(BlockedAddressError);
  });

  it("rejects an entry that is not a host or host:port", () => {
    expect(() => guard({ resolve: async () => [], allowHosts: ["fake.test/path"] })).toThrow(
      /host or host:port/,
    );
  });

  it("does not reach a listed host in the HTTPS-only mode over plain HTTP", async () => {
    const fetch = createGuardedFetch({
      schemes: "https",
      resolve: async () => ["127.0.0.1"],
      allowHosts: ["fake.test"],
    });

    await expect(fetch(`http://fake.test:${port}/`)).rejects.toThrow(/HTTPS/);
  });
});
