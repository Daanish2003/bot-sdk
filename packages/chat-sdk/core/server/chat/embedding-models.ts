import { embed } from "@tanstack/ai";
import { GEMINI_EMBEDDING_MODELS } from "@tanstack/ai-gemini";
import { OPENAI_EMBEDDING_MODELS } from "@tanstack/ai-openai";

import { parseModelId } from "../../shared/chat/models";
import { resolveCredentials } from "../credentials/resolve";
import type { AppDeps, Credentials, HostProvider } from "../deps";
import { recordEmbeddingUsage } from "./host-usage";

/**
 * The vector size every embedding Model is asked for, so one column holds them all (ADR 0014).
 * Gemini's output is shortened to it and normalised; OpenAI's is asked for it directly.
 */
export const embeddingDimensions = 1536;

/** The Providers that serve embedding Models (ADR 0014). */
type EmbeddingProvider = "openai" | "gemini";

const embeddingModelsOf: Record<EmbeddingProvider, readonly string[]> = {
  openai: OPENAI_EMBEDDING_MODELS,
  gemini: GEMINI_EMBEDDING_MODELS,
};

/** Every embedding Model the SDK knows, as `"provider:model"`, in the order of its Providers. */
export function embeddingModelIds(): string[] {
  return (Object.keys(embeddingModelsOf) as EmbeddingProvider[]).flatMap((provider) =>
    embeddingModelsOf[provider].map((modelId) => `${provider}:${modelId}`),
  );
}

/** The Model a user gets on their own key of each Provider, when they've picked none. */
const defaultModelOf: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
};

/** The most inputs one request takes: OpenAI's 2,048, and 100 for Gemini, which we can't verify. */
const inputsPerRequest: Record<EmbeddingProvider, number> = { openai: 2_048, gemini: 100 };

/**
 * The most characters one request sends. OpenAI's cap is 300,000 tokens a request; a token is at
 * most a few UTF-16 units, so 100,000 characters stays under it.
 */
const charactersPerRequest = 100_000;

/** The Gemini task type each use of an embedding asks for (OpenAI has none). */
const taskTypeOf = { document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" } as const;

function isEmbeddingProvider(provider: string): provider is EmbeddingProvider {
  return provider === "openai" || provider === "gemini";
}

/** A Model that embeds on the user's own key (not metered) or on the Host's, which is priced. */
export type ResolvedEmbeddingModel = {
  /** The `"provider:model"` id. */
  id: string;
  provider: EmbeddingProvider;
  modelId: string;
  /** The credentials the call runs with. */
  credentials: Credentials;
} & ({ onHostCredentials: false } | { onHostCredentials: true; pricePerMillionTokensUsd: number });

type Deps = Pick<AppDeps, "db" | "keyEncryptionSecrets" | "hostProviders" | "byok">;

/** The Host's embedding Models, in the order the Host listed them, with the credentials to use. */
function hostOffers(deps: Pick<AppDeps, "hostProviders">) {
  return deps.hostProviders.flatMap((hostProvider: HostProvider) =>
    (hostProvider.embeddingModels ?? []).flatMap(({ model, pricePerMillionTokensUsd }) =>
      isEmbeddingProvider(hostProvider.provider) &&
      embeddingModelsOf[hostProvider.provider].includes(model)
        ? [
            {
              provider: hostProvider.provider,
              modelId: model,
              credentials: hostProvider.credentials,
              pricePerMillionTokensUsd,
            },
          ]
        : [],
    ),
  );
}

/**
 * The embedding Model a user's Knowledge uses by default (ADR 0014): OpenAI's small Model on their
 * own OpenAI key, else Gemini's on their own Gemini key, else the Host's first embedding Model.
 * `null` when none applies. The user's own key is ignored when the Host turns BYOK off.
 */
export async function defaultEmbeddingModel(
  deps: Deps,
  userId: string,
): Promise<ResolvedEmbeddingModel | null> {
  if (deps.byok) {
    for (const provider of ["openai", "gemini"] as const) {
      const own = await resolveCredentials(deps, userId, provider);
      if (own) {
        const modelId = defaultModelOf[provider];
        return {
          id: `${provider}:${modelId}`,
          provider,
          modelId,
          credentials: own,
          onHostCredentials: false,
        };
      }
    }
  }
  const [offer] = hostOffers(deps);
  return offer ? hostModel(offer) : null;
}

/**
 * The credentials an embedding Model `"provider:model"` runs with (ADR 0014): the user's own key
 * for its Provider, else the Host's credentials when the Host offers that Model, else `null`.
 */
export async function resolveEmbeddingModel(
  deps: Deps,
  userId: string,
  id: string,
): Promise<ResolvedEmbeddingModel | null> {
  const parsed = parseModelId(id);
  if (!parsed || !isEmbeddingProvider(parsed.provider)) return null;
  const { provider, modelId } = parsed;
  if (!embeddingModelsOf[provider].includes(modelId)) return null;
  const own = deps.byok ? await resolveCredentials(deps, userId, provider) : null;
  if (own) return { id, provider, modelId, credentials: own, onHostCredentials: false };
  const offer = hostOffers(deps).find(
    (entry) => entry.provider === provider && entry.modelId === modelId,
  );
  return offer ? hostModel(offer) : null;
}

/** A Host's offer as a Model on the Host's credentials. */
function hostModel(offer: ReturnType<typeof hostOffers>[number]): ResolvedEmbeddingModel {
  return {
    id: `${offer.provider}:${offer.modelId}`,
    provider: offer.provider,
    modelId: offer.modelId,
    credentials: offer.credentials,
    onHostCredentials: true,
    pricePerMillionTokensUsd: offer.pricePerMillionTokensUsd,
  };
}

/**
 * Why a Host's `embeddingModels` can't be served, or `null` (ADR 0014): only OpenAI and Gemini
 * serve them, only their own embedding Models, and each Model needs a price.
 */
export function embeddingModelsProblem(entry: HostProvider): string | null {
  if (!entry.embeddingModels?.length) return null;
  if (!isEmbeddingProvider(entry.provider)) {
    return `hostProviders: ${entry.provider} has no embedding adapter, so it can't list embeddingModels`;
  }
  for (const { model, pricePerMillionTokensUsd } of entry.embeddingModels) {
    if (!embeddingModelsOf[entry.provider].includes(model)) {
      return `hostProviders: ${entry.provider} has no embedding Model "${model}"`;
    }
    if (!(pricePerMillionTokensUsd >= 0)) {
      return `Host embedding Model "${entry.provider}:${model}" needs a pricePerMillionTokensUsd`;
    }
  }
  return null;
}

/** The texts, split into the requests a Provider takes: by count, and by characters. */
function requestsOf(provider: EmbeddingProvider, texts: string[]): string[][] {
  const requests: string[][] = [];
  let request: string[] = [];
  let characters = 0;
  for (const text of texts) {
    const full =
      request.length === inputsPerRequest[provider] ||
      (request.length > 0 && characters + text.length > charactersPerRequest);
    if (full) {
      requests.push(request);
      request = [];
      characters = 0;
    }
    request.push(text);
    characters += text.length;
  }
  if (request.length > 0) requests.push(request);
  return requests;
}

/** The vector scaled to unit length. Gemini's shortened vectors aren't, and OpenAI's already are. */
function unitLength(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

/**
 * Embeds the texts with an embedding Model, `embeddingDimensions` long and unit length (ADR 0014).
 * The texts are split into the Provider's requests, one TanStack AI `embed()` each. A request on
 * Host credentials is metered once it succeeds, so a failed one is not billed.
 * `purpose` tells Gemini whether the texts are documents or a query.
 */
export async function embedTexts(
  deps: Pick<AppDeps, "db" | "hooks" | "embeddingAdapterFor">,
  {
    userId,
    model,
    texts,
    purpose,
  }: {
    userId: string;
    model: ResolvedEmbeddingModel;
    texts: string[];
    purpose: "document" | "query";
  },
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const request of requestsOf(model.provider, texts)) {
    const adapter = deps.embeddingAdapterFor(model.id, model.credentials);
    const result = await embed({
      adapter,
      input: request,
      dimensions: embeddingDimensions,
      ...(model.provider === "gemini" && { modelOptions: { taskType: taskTypeOf[purpose] } }),
    });
    vectors.push(...result.embeddings.map(({ vector }) => unitLength(vector)));
    if (model.onHostCredentials) {
      // Gemini reports no usage, so its tokens are the characters ÷ 4, and the row says so.
      const reported = model.provider === "openai" ? result.usage?.promptTokens : undefined;
      await recordEmbeddingUsage(
        deps,
        { userId, model: model.id, pricePerMillionTokensUsd: model.pricePerMillionTokensUsd },
        {
          tokens: reported ?? Math.ceil(request.join("").length / 4),
          estimated: reported === undefined,
        },
      );
    }
  }
  return vectors;
}
