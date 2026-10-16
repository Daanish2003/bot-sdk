/**
 * A `deps.fetch` that answers the live Model list requests: OpenRouter's models API with
 * `openRouter` (ids that support tools) and any Ollama host's `/api/tags` with `ollama` (installed
 * Model names). Anything else is an unexpected network call. Records the URLs it was called with.
 */
export function liveModelsFetch({
  openRouter = [],
  openRouterReasoning = {},
  ollama = [],
}: {
  openRouter?: string[];
  /** OpenRouter Models that also take `reasoning`, with the efforts each lists. */
  openRouterReasoning?: Record<string, string[]>;
  ollama?: string[];
}) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://openrouter.ai/api/v1/models") {
      const reasoning = Object.keys(openRouterReasoning);
      return Response.json({
        data: [...openRouter, ...reasoning].map((id) => ({
          id,
          name: `OpenRouter ${id}`,
          architecture: { input_modalities: ["text"] },
          supported_parameters: reasoning.includes(id) ? ["tools", "reasoning"] : ["tools"],
          ...(reasoning.includes(id) && {
            reasoning: { supported_efforts: openRouterReasoning[id] },
          }),
        })),
      });
    }
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: ollama.map((name) => ({ name, model: name })) });
    }
    throw new Error(`Unexpected network call in a test: ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}
