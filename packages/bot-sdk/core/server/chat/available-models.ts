import { conversation } from "../db/schema";
import { desc, eq } from "drizzle-orm";

import { resolvedServices, hostModelList } from "../credentials/resolve";
import { loadCredentials } from "../credentials/store";
import { tavilyService } from "../../shared/credentials/services";
import type { AppDeps } from "../deps";
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
} from "../../shared/chat/models";
import type { ListedImageModel } from "../../shared/chat/image-models";

type Deps = Pick<
  AppDeps,
  | "db"
  | "keyEncryptionSecrets"
  | "fetch"
  | "ollamaFetch"
  | "hostProviders"
  | "hostTools"
  | "byok"
  | "defaultBackgroundModel"
  | "defaultImageModel"
>;

/**
 * The Models the user can chat with: those of Providers they have their own credentials for (with
 * the live OpenRouter and Ollama lists), then the Host's Models for the other Providers, marked as
 * running on Host credentials (ADR 0007). The user's own key for a Provider wins, so its Host
 * Models are not listed. The Model a new Conversation starts on: the Model of their most recent
 * Conversation while it is still available, else the code default of the first Provider they added
 * or the Host offers (or that Provider's first Model, when the default isn't listed).
 */
export async function listAvailableModels(
  deps: Deps,
  userId: string,
): Promise<{
  models: ListedModel[];
  defaultModel: string | null;
  /** The Host's default Background Model, shown when a user picks none (`defaultBackgroundModel`). */
  defaultBackgroundModel: string | null;
  /** The Image Models the user can pick: their own Providers' first, then the Host's (spec #278). */
  imageModels: ListedImageModel[];
  /** The Host's default Image Model, shown when a user picks none (`defaultImageModel`). */
  defaultImageModel: string | null;
  webSearchOnHost: boolean;
}> {
  const services = deps.byok ? await resolvedServices(deps, userId) : [];
  const own = [
    ...curatedModels.filter((model) => services.includes(model.provider)),
    ...(
      await Promise.all(
        services.filter(isLiveListProvider).map((provider) => liveModels(deps, userId, provider)),
      )
    ).flat(),
  ];
  const hosted = hostModelList(deps).filter((model) => !services.includes(model.provider));
  const models: ListedModel[] = [
    ...own.map((model) => ({ ...model, onHostCredentials: false })),
    ...hosted.map((model) => ({ ...model, onHostCredentials: true })),
  ];

  const [recent] = await deps.db
    .select({ model: conversation.model })
    .from(conversation)
    .where(eq(conversation.userId, userId))
    .orderBy(desc(conversation.lastMessageAt), desc(conversation.id))
    .limit(1);
  const recentModel = models.find((model) => model.id === recent?.model)?.id;
  const firstProvider = [...services, ...deps.hostProviders.map((host) => host.provider)]
    .map((service) => models.find((model) => model.provider === service)?.provider)
    .find((provider) => provider !== undefined);
  const providerDefault =
    firstProvider &&
    (
      models.find((model) => model.id === defaultModelFor(firstProvider)) ??
      models.find((model) => model.provider === firstProvider)
    )?.id;

  return {
    models,
    defaultModel: recentModel ?? providerDefault ?? null,
    defaultBackgroundModel: deps.defaultBackgroundModel,
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
