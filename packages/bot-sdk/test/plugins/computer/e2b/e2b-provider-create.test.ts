import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  create: vi.fn(),
  getHost: vi.fn((port: number) => `${port}-sbx1.e2b.test`),
}));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: {
    create: sandbox.create,
    connect: vi.fn(async () => ({ sandboxId: "sbx1", getHost: sandbox.getHost })),
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
  sandbox.create.mockResolvedValue({ sandboxId: "sbx1", getHost: sandbox.getHost });
});

describe("e2bProvider.create", () => {
  it("creates the sandbox with public traffic off, from the template", async () => {
    await provider.create({ timeoutMs: 1000 });

    expect(sandbox.create).toHaveBeenCalledWith(
      "ai-chat-computer-v3",
      expect.objectContaining({ network: { allowPublicTraffic: false }, timeoutMs: 1000 }),
    );
  });

  it("gives the https URL of a port of the sandbox", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 1000 });

    expect(await provider.hostUrl(sandboxId, 6081)).toBe("https://6081-sbx1.e2b.test");
  });
});
