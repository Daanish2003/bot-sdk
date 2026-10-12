import { describe, expect, it } from "vitest";

import { ollamaModels, openRouterModels } from "../../../../core/server/chat/live-models";

function stubFetch(respond: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A trimmed answer of OpenRouter's `GET /api/v1/models`. */
const openRouterList = {
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Anthropic: Claude Sonnet 5.5",
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: false },
      supported_parameters: ["max_tokens", "tools", "tool_choice", "reasoning"],
      reasoning: {
        mandatory: false,
        supported_efforts: ["max", "xhigh", "high", "medium", "low"],
        default_effort: "medium",
      },
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek: DeepSeek V4 Pro",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools", "temperature", "reasoning"],
      reasoning: { supported_efforts: ["high", "none"], default_effort: "none" },
    },
    {
      id: "mancer/weaver",
      name: "Mancer: Weaver",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["temperature"],
    },
    {
      id: "acme/brand-new-model",
      name: "Acme: Brand New",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
  ],
};

describe("openRouterModels", () => {
  it("lists OpenRouter's chat Models that support tools, with images from input modalities and PDFs off", async () => {
    const { fetch, urls } = stubFetch(() => json(openRouterList));

    const models = await openRouterModels(fetch);

    expect(urls).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(models).toEqual([
      {
        id: "openrouter:anthropic/claude-sonnet-5.5",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-5.5",
        label: "Anthropic: Claude Sonnet 5.5",
        images: true,
        pdfs: false,
        tools: true,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: { efforts: ["low", "medium", "high"], off: false, defaultEffort: "medium" },
      },
      {
        id: "openrouter:deepseek/deepseek-v4-pro",
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        label: "DeepSeek: DeepSeek V4 Pro",
        images: false,
        pdfs: false,
        tools: true,
        contextWindow: null,
        maxOutputTokens: null,
        reasoning: { efforts: ["high"], off: true, defaultEffort: "off" },
      },
    ]);
  });

  it("reads a Model's reasoning efforts only when it lists the reasoning parameter", async () => {
    const { fetch } = stubFetch(() =>
      json({
        data: [
          {
            id: "anthropic/claude-sonnet-5.5",
            name: "Claude Sonnet 5.5",
            architecture: { input_modalities: ["text"] },
            supported_parameters: ["tools"],
            reasoning: { supported_efforts: ["low", "high"], default_effort: "low" },
          },
        ],
      }),
    );

    const [model] = await openRouterModels(fetch);

    expect(model?.reasoning).toEqual({ efforts: [], off: false, defaultEffort: null });
  });

  it("doesn't call the default off when the Model doesn't allow reasoning to be turned off", async () => {
    const { fetch } = stubFetch(() =>
      json({
        data: [
          {
            id: "deepseek/deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            architecture: { input_modalities: ["text"] },
            supported_parameters: ["tools"],
            reasoning: { supported_efforts: ["high", "none"], default_effort: "none" },
          },
        ],
      }),
    );

    const [model] = await openRouterModels(fetch);

    expect(model?.reasoning).toEqual({ efforts: [], off: false, defaultEffort: null });
  });

  it("keeps the list instead of asking again within the hour", async () => {
    const { fetch, urls } = stubFetch(() => json(openRouterList));

    await openRouterModels(fetch);
    const again = await openRouterModels(fetch);

    expect(urls).toHaveLength(1);
    expect(again).toHaveLength(2);
  });

  it("lists nothing when OpenRouter fails, and asks again next time", async () => {
    let answer = () => json({ error: "down" }, 503);
    const { fetch, urls } = stubFetch(() => answer());

    await expect(openRouterModels(fetch)).resolves.toEqual([]);
    answer = () => json(openRouterList);
    await expect(openRouterModels(fetch)).resolves.toHaveLength(2);
    expect(urls).toHaveLength(2);
  });

  it("lists nothing when OpenRouter can't be reached", async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(openRouterModels(fetch)).resolves.toEqual([]);
  });
});

describe("ollamaModels", () => {
  it("lists the Models installed on the host, text-only with tools on", async () => {
    const { fetch, urls } = stubFetch(() =>
      json({
        models: [
          { name: "llama3.2:latest", model: "llama3.2:latest", size: 2019393189 },
          { name: "qwen3:8b", model: "qwen3:8b", size: 5225388164 },
        ],
      }),
    );

    const models = await ollamaModels(fetch, "http://localhost:11434");

    expect(urls).toEqual(["http://localhost:11434/api/tags"]);
    expect(models).toEqual([
      {
        id: "ollama:llama3.2:latest",
        provider: "ollama",
        modelId: "llama3.2:latest",
        label: "llama3.2:latest",
        images: false,
        pdfs: false,
        tools: true,
        contextWindow: null,
        maxOutputTokens: null,
        reasoning: { efforts: [], off: false, defaultEffort: null },
      },
      {
        id: "ollama:qwen3:8b",
        provider: "ollama",
        modelId: "qwen3:8b",
        label: "qwen3:8b",
        images: false,
        pdfs: false,
        tools: true,
        contextWindow: null,
        maxOutputTokens: null,
        reasoning: { efforts: [], off: false, defaultEffort: null },
      },
    ]);
  });

  it("lists nothing when the host can't be reached", async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(ollamaModels(fetch, "http://localhost:11434")).resolves.toEqual([]);
  });

  it("lists nothing when the host answers with an error", async () => {
    const { fetch } = stubFetch(() => json({ error: "nope" }, 500));

    await expect(ollamaModels(fetch, "http://localhost:11434")).resolves.toEqual([]);
  });
});
