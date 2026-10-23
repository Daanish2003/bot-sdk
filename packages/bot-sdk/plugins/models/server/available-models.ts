import { shownLinkedPlan, resolvedServices, hostModelList } from "./credentials/resolve";
import { loadCredentials } from "./credentials/store";
import { chatgptPlanModels, tavilyService } from "../shared/credentials/services";
import type { ModelsDeps } from "./types";
import { ollamaModels, openRouterModels } from "./live-models";
import { listImageModels } from "./image-models";
import {
  type CuratedModel,
  type ListedModel,
  curatedModels,
  defaultModelFor,
  findModel,
  isLiveListProvider,
  parseModelId,
} from "../shared/models";
import type { ListedImageModel } from "../shared/image-models";

type Deps = Pick<
  ModelsDeps,
  | "db"
  | "keyEncryptionSecrets"
  | "fetch"
  | "ollamaFetch"
  | "hostProviders"
  | "hostTools"
  | "byok"
  | "linkedCredentials"
  | "logger"
  | "defaultImageModel"
  | "recentModelSources"
>;

/**
 * The Models the user can chat with: those of Providers they have their own credentials for (with
 * the live OpenRouter and Ollama lists), then the Host's Models for the other Providers, marked as
 * running on Host credentials (ADR 0007). The user's own key for a Provider wins, so its Host
 * Models are not listed; so does a linked ChatGPT plan for the Models it offers (ADR 0023). The Model a new Conversation starts on: the first recent-Model source's Model that is
 * still available (`addRecentModelSource`), else the code default of the first Provider they added
 * or the Host offers (or that Provider's first Model, when the default isn't listed).
 */
export async function listAvailableModels(
  deps: Deps,
  userId: string,
): Promise<{
  models: ListedModel[];
  defaultModel: string | null;
  /** The Image Models the user can pick: their own Providers' first, then the Host's (spec #278). */
  imageModels: ListedImageModel[];
  /** The Host's default Image Model, shown when a user picks none (`defaultImageModel`). */
  defaultImageModel: string | null;
  webSearchOnHost: boolean;
}> {
  const services = deps.byok ? await resolvedServices(deps, userId) : [];
  // A linked plan offers its Models when the user has no OpenAI key; a broken link still lists
  // them, so picking one asks to reconnect rather than running on the Host (ADR 0023).
  const planModels =
    !services.includes("openai") && (await shownLinkedPlan(deps, userId))
      ? curatedModels.filter((model) => chatgptPlanModels.includes(model.id))
      : [];
  const own = [
    ...curatedModels.filter((model) => services.includes(model.provider)),
    ...planModels,
    ...(
      await Promise.all(
        services.filter(isLiveListProvider).map((provider) => liveModels(deps, userId, provider)),
      )
    ).flat(),
  ];
  const hosted = hostModelList(deps).filter(
    (model) =>
      !services.includes(model.provider) && !planModels.some((plan) => plan.id === model.id),
  );
  const models: ListedModel[] = [
    ...own.map((model) => ({ ...model, onHostCredentials: false })),
    ...hosted.map((model) => ({ ...model, onHostCredentials: true })),
  ];

  let recentModel: string | undefined;
  for (const source of deps.recentModelSources) {
    const recent = await source(userId);
    recentModel = models.find((model) => model.id === recent)?.id;
    if (recentModel) break;
  }
  const firstProvider = [
    ...services,
    ...(planModels.length > 0 ? ["openai"] : []),
    ...deps.hostProviders.map((host) => host.provider),
  ]
    .map((service) => models.find((model) => model.provider === service)?.provider)
    .find((provider) => provider !== undefined);
  // The user's own Models of that Provider come first: a linked plan's, not the Host's beside them.
  const ofFirst = models.filter((model) => model.provider === firstProvider);
  const pool = ofFirst.some((model) => !model.onHostCredentials)
    ? ofFirst.filter((model) => !model.onHostCredentials)
    : ofFirst;
  const providerDefault =
    firstProvider &&
    (pool.find((model) => model.id === defaultModelFor(firstProvider)) ?? pool[0])?.id;

  return {
    models,
    defaultModel: recentModel ?? providerDefault ?? null,
    imageModels: listImageModels(deps, services),
    defaultImageModel: deps.defaultImageModel,
    // The Host's Tavily key, which search uses for a user with no Tool credential of their own (ADR 0007).
    webSearchOnHost: deps.hostTools.some((tool) => tool.tool === tavilyService),
  };
}

/**
 * The Model for a `"provider:model"` id the user can pick: one of the Host's Models, a curated one,
 * or one on the live OpenRouter list or the user's Ollama host. `undefined` when it is none of those.
 */
export async function resolveModel(
  deps: Deps,
  userId: string,
  id: string,
): Promise<CuratedModel | undefined> {
  const hosted = hostModelList(deps).find((model) => model.id === id);
  if (hosted) return hosted;
  const curated = findModel(id);
  if (curated) return curated;
  const provider = parseModelId(id)?.provider;
  const live = provider ? await liveModels(deps, userId, provider) : [];
  return live.find((model) => model.id === id);
}

/** The live list of `provider` (OpenRouter's, or the user's Ollama host's); empty for others. */
async function liveModels(deps: Deps, userId: string, provider: string) {
  if (provider === "openrouter") return openRouterModels(deps.fetch);
  if (provider !== "ollama") return [];
  const host = (await loadCredentials(deps, userId, "ollama"))?.host;
  return host ? ollamaModels(deps.ollamaFetch, host) : [];
}
