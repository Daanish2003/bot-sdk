import { describe, expect, it } from "vitest";

import { checkCredentials } from "../../src/models/internal";

type Call = { url: string; headers: Headers };

function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("checkCredentials for Anthropic", () => {
  it("lists models with the key and counts a 200 as verified", async () => {
    const { fetch, calls } = stubFetch(() => json(200, { data: [] }));

    const result = await checkCredentials("anthropic", { apiKey: "sk-ant-good" }, fetch);

    expect(result).toEqual({ status: "verified" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant-good");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("rejects a key Anthropic answers 401 to as invalid", async () => {
    const { fetch } = stubFetch(() => json(401, { type: "error" }));

    const result = await checkCredentials("anthropic", { apiKey: "sk-ant-typo" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_key",
      message: "Anthropic rejected this API key.",
      code: "error.keyRejected",
      params: { label: "Anthropic" },
    });
  });
});

describe("checkCredentials for OpenAI", () => {
  it("lists models with a bearer token and counts a 200 as verified", async () => {
    const { fetch, calls } = stubFetch(() => json(200, { data: [] }));

    const result = await checkCredentials("openai", { apiKey: "sk-good" }, fetch);

    expect(result).toEqual({ status: "verified" });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-good");
  });

  it("rejects a key OpenAI answers 403 to as invalid", async () => {
    const { fetch } = stubFetch(() => json(403));

    const result = await checkCredentials("openai", { apiKey: "sk-no-scope" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_key",
      message: "OpenAI rejected this API key.",
      code: "error.keyRejected",
      params: { label: "OpenAI" },
    });
  });

  it("counts a rate-limited answer as verified, since the key authenticated", async () => {
    const { fetch } = stubFetch(() => json(429));

    await expect(checkCredentials("openai", { apiKey: "sk-busy" }, fetch)).resolves.toEqual({
      status: "verified",
    });
  });

  it("rejects with provider_error when the Provider fails", async () => {
    const { fetch } = stubFetch(() => json(503));

    const result = await checkCredentials("openai", { apiKey: "sk-good" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "provider_error",
      message: "Couldn't check the key with OpenAI (HTTP 503). Try again.",
      code: "error.keyCheckFailed",
      params: { label: "OpenAI", status: 503 },
    });
  });

  it("rejects with provider_error when the Provider can't be reached", async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const result = await checkCredentials("openai", { apiKey: "sk-good" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "provider_error",
      message: "Couldn't reach OpenAI to check the key. Try again.",
      code: "error.keyUnreachable",
      params: { label: "OpenAI" },
    });
  });
});

describe("checkCredentials for the other Providers", () => {
  it.each([
    {
      service: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      header: ["x-goog-api-key", "key-good"],
    },
    {
      service: "openrouter",
      url: "https://openrouter.ai/api/v1/key",
      header: ["authorization", "Bearer key-good"],
    },
    {
      service: "mistral",
      url: "https://api.mistral.ai/v1/models",
      header: ["authorization", "Bearer key-good"],
    },
    {
      service: "groq",
      url: "https://api.groq.com/openai/v1/models",
      header: ["authorization", "Bearer key-good"],
    },
    {
      service: "grok",
      url: "https://api.x.ai/v1/models",
      header: ["authorization", "Bearer key-good"],
    },
    {
      service: "byteplus",
      url: "https://ark.ap-southeast.bytepluses.com/api/v3/models",
      header: ["authorization", "Bearer key-good"],
    },
    {
      service: "vercel-gateway",
      url: "https://ai-gateway.vercel.sh/v1/credits",
      header: ["authorization", "Bearer key-good"],
    },
  ] as const)("checks $service with $url", async ({ service, url, header }) => {
    const { fetch, calls } = stubFetch(() => json(200));

    const result = await checkCredentials(service, { apiKey: "key-good" }, fetch);

    expect(result).toEqual({ status: "verified" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(url);
    expect(calls[0]?.headers.get(header[0])).toBe(header[1]);
  });

  it("rejects a key Gemini answers 400 to as invalid, since that is how it refuses keys", async () => {
    const { fetch } = stubFetch(() => json(400, { error: { status: "INVALID_ARGUMENT" } }));

    const result = await checkCredentials("gemini", { apiKey: "AIza-typo" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_key",
      message: "Google Gemini rejected this API key.",
      code: "error.keyRejected",
      params: { label: "Google Gemini" },
    });
  });

  it("checks a Cloudflare token against the account's Workers AI models", async () => {
    const { fetch, calls } = stubFetch(() => json(200, { success: true }));

    const result = await checkCredentials(
      "cloudflare",
      { accountId: "acc123", apiKey: "cf-token" },
      fetch,
    );

    expect(result).toEqual({ status: "verified" });
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/models/search?per_page=1",
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer cf-token");
  });

  it("checks that the Ollama host is reachable by listing its installed Models", async () => {
    const { fetch, calls } = stubFetch(() => json(200, { models: [] }));

    const result = await checkCredentials("ollama", { host: "http://localhost:11434" }, fetch);

    expect(result).toEqual({ status: "verified" });
    expect(calls[0]?.url).toBe("http://localhost:11434/api/tags");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("explains an unreachable Ollama host, with the Docker hint", async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const result = await checkCredentials("ollama", { host: "http://localhost:11434" }, fetch);

    expect(result).toEqual({
      status: "rejected",
      reason: "provider_error",
      message:
        "Couldn't reach Ollama at http://localhost:11434. Under Docker, use http://host.docker.internal:11434.",
      code: "error.ollamaUnreachable",
      params: { host: "http://localhost:11434" },
    });
  });

  it("doesn't treat an Ollama 401 as a rejected key, since Ollama has none", async () => {
    const { fetch } = stubFetch(() => json(401));

    const result = await checkCredentials("ollama", { host: "http://localhost:11434" }, fetch);

    expect(result).toMatchObject({ status: "rejected", reason: "provider_error" });
  });

  it.each(["llmgateway", "lovable", "bedrock"] as const)(
    "saves %s credentials as not verified without calling the Provider",
    async (service) => {
      const { fetch, calls } = stubFetch(() => json(200));

      const result = await checkCredentials(
        service,
        { apiKey: "key-good", region: "us-east-1" },
        fetch,
      );

      expect(result).toEqual({ status: "unverified" });
      expect(calls).toEqual([]);
    },
  );
});
