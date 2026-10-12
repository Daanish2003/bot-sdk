import { OPENROUTER_CHAT_MODELS } from "@tanstack/ai-openrouter/model-meta";
import { z } from "zod";

import {
  type CuratedModel,
  type ReasoningEffort,
  type ReasoningSupport,
  unknownReasoning,
} from "../../shared/chat/models";

/**
 * The live Model lists of OpenRouter and Ollama, fetched through `deps.fetch`. A list that
 * can't be fetched is empty: the picker just shows no Models for that Provider.
 */

// Everything past `id` and `name` is nullish: one odd value on one Model must not empty the list.
const openRouterListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      architecture: z.object({ input_modalities: z.array(z.string()) }).optional(),
      supported_parameters: z.array(z.string()).optional(),
      context_length: z.number().nullish(),
      top_provider: z.object({ max_completion_tokens: z.number().nullish() }).nullish(),
      reasoning: z
        .object({
          supported_efforts: z.array(z.string()).nullish(),
          default_effort: z.string().nullish(),
        })
        .nullish(),
    }),
  ),
});

type OpenRouterEntry = z.infer<typeof openRouterListSchema>["data"][number];

const ollamaTagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });

const effortLevels: ReasoningEffort[] = ["low", "medium", "high"];

const openRouterTtlMs = 60 * 60_000;
const openRouterChatModels = new Set<string>(OPENROUTER_CHAT_MODELS);
/** The OpenRouter list per `fetch`, so tests (each with their own stub) don't share it. */
const openRouterCache = new WeakMap<typeof fetch, { expiresAt: number; models: CuratedModel[] }>();

/**
 * OpenRouter's chat Models that support tools (the adapter's `OPENROUTER_CHAT_MODELS` only),
 * cached for an hour. Images come from the input modalities; PDFs are off (Chat Completions).
 * The window, max output and reasoning efforts come from the same answer; a Model that doesn't
 * state one of them gets it unknown.
 */
export async function openRouterModels(fetch: typeof globalThis.fetch): Promise<CuratedModel[]> {
  const cached = openRouterCache.get(fetch);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const list = await fetchJson(fetch, "https://openrouter.ai/api/v1/models", openRouterListSchema);
  if (!list) return [];
  const models = list.data
    .filter(
      (entry) =>
        openRouterChatModels.has(entry.id) && entry.supported_parameters?.includes("tools"),
    )
    .map((entry) =>
      liveModel("openrouter", entry.id, entry.name, {
        images: entry.architecture?.input_modalities.includes("image") ?? false,
        contextWindow: entry.context_length ?? null,
        maxOutputTokens: entry.top_provider?.max_completion_tokens ?? null,
        reasoning: openRouterReasoning(entry),
      }),
    );
  openRouterCache.set(fetch, { expiresAt: Date.now() + openRouterTtlMs, models });
  return models;
}

/**
 * A Model's reasoning on OpenRouter. Efforts count only when the Model lists the `reasoning`
 * parameter; `none` means `off`; the default is kept when it's a level, or `none` as `off`.
 */
function openRouterReasoning(entry: OpenRouterEntry): ReasoningSupport {
  const listed = entry.supported_parameters?.includes("reasoning")
    ? (entry.reasoning?.supported_efforts ?? [])
    : [];
  const efforts = effortLevels.filter((level) => listed.includes(level));
  const off = listed.includes("none");
  const declared = entry.reasoning?.default_effort;
  const defaultEffort =
    declared === "none" && off ? "off" : (efforts.find((level) => level === declared) ?? null);
  return { efforts, off, defaultEffort };
}

/**
 * The Models installed on the user's Ollama host: text-only, with tools on. Ollama's window
 * depends on the host's `num_ctx`, which isn't looked up, so the window and efforts stay unknown.
 */
export async function ollamaModels(
  fetch: typeof globalThis.fetch,
  host: string,
): Promise<CuratedModel[]> {
  const tags = await fetchJson(fetch, `${host}/api/tags`, ollamaTagsSchema);
  return (tags?.models ?? []).map((entry) =>
    liveModel("ollama", entry.name, entry.name, {
      images: false,
      contextWindow: null,
      maxOutputTokens: null,
      reasoning: unknownReasoning(),
    }),
  );
}

function liveModel(
  provider: "openrouter" | "ollama",
  modelId: string,
  label: string,
  limits: Pick<CuratedModel, "images" | "contextWindow" | "maxOutputTokens" | "reasoning">,
): CuratedModel {
  return {
    id: `${provider}:${modelId}`,
    provider,
    modelId,
    label,
    pdfs: false,
    tools: true,
    ...limits,
  };
}

async function fetchJson<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
