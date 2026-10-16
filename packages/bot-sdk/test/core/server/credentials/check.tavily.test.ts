import { describe, expect, it } from "vitest";

import { checkCredentials } from "../../../../plugins/models/server/credentials/check";

function stubFetch(status: number) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({ key: { usage: 0 } }, { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("checkCredentials for the Tavily Tool credential", () => {
  it("reads the key's usage with a bearer token, which costs no search credits", async () => {
    const { fetch, calls } = stubFetch(200);

    const result = await checkCredentials("tavily", { apiKey: "tvly-good" }, fetch);

    expect(result).toEqual({ status: "verified" });
    expect(calls[0]?.url).toBe("https://api.tavily.com/usage");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tvly-good");
  });

  it("rejects a key Tavily answers 401 to as invalid", async () => {
    const { fetch } = stubFetch(401);

    const result = await checkCredentials("tavily", { apiKey: "tvly-typo" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_key",
      message: "Tavily rejected this API key.",
      code: "error.keyRejected",
      params: { label: "Tavily" },
    });
  });
});
