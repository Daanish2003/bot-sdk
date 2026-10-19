import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  create: vi.fn(),
  getHost: vi.fn((port: number) => `${port}-sbx1.e2b.test`),
}));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: {
    create: sandbox.create,
    connect: vi.fn(async () => ({
      sandboxId: "sbx1",
      getHost: sandbox.getHost,
      trafficAccessToken: "traffic-1",
    })),
  },
}));

import { e2bProvider } from "../../../../plugins/computer/e2b";

const provider = e2bProvider({
  apiKey: "key",
  apiUrl: "http://api.test",
  sandboxUrl: "http://sandbox.test",
  template: "ai-chat-computer-v3",
});

beforeEach(() => {
  sandbox.create.mockReset();
  sandbox.getHost.mockClear();
  sandbox.create.mockResolvedValue({
    sandboxId: "sbx1",
    getHost: sandbox.getHost,
    trafficAccessToken: "traffic-1",
  });
});

describe("e2bProvider.create", () => {
  it("creates the sandbox with public traffic off, from the template", async () => {
    await provider.create({ timeoutMs: 1000 });

    expect(sandbox.create).toHaveBeenCalledWith(
      "ai-chat-computer-v3",
      expect.objectContaining({ network: { allowPublicTraffic: false }, timeoutMs: 1000 }),
    );
  });
});

describe("e2bProvider.endpoint", () => {
  it("routes a port through sandboxUrl with the routing headers and the traffic token", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 1000 });

    expect(await provider.endpoint(sandboxId, 9223)).toEqual({
      url: "http://sandbox.test",
      headers: {
        "e2b-traffic-access-token": "traffic-1",
        "E2b-Sandbox-Id": "sbx1",
        "E2b-Sandbox-Port": "9223",
      },
    });
  });

  it("never names a host of the sandbox domain when sandboxUrl is set", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 1000 });

    const endpoints = [
      await provider.endpoint(sandboxId, 6081),
      await provider.endpoint(sandboxId, 9223),
    ];

    expect(sandbox.getHost).not.toHaveBeenCalled();
    for (const { url } of endpoints) expect(new URL(url).host).toBe("sandbox.test");
  });

  it("gives the https URL of the port with the traffic token when sandboxUrl is unset", async () => {
    const cloud = e2bProvider({ apiKey: "key", apiUrl: "http://api.test", template: "t" });

    expect(await cloud.endpoint("sbx1", 6081)).toEqual({
      url: "https://6081-sbx1.e2b.test",
      headers: { "e2b-traffic-access-token": "traffic-1" },
    });
  });
});
