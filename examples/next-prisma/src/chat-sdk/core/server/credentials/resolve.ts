import {
  findModel,
  parseModelId,
  type CuratedModel,
  unknownReasoning,
} from "../../shared/chat/models";
import type { AppDeps, Credentials, HostModel, HostProvider, HostTool } from "../deps";
import { listCredentials, loadCredentials } from "./store";

type Deps = Pick<AppDeps, "db" | "keyEncryptionSecrets">;

/**
 * The one place that decides which credentials a call uses. For a Provider or Tool `service`, a
 * call uses the user's own credentials for it, or none. Every call (a Run, a title, a web search,
 * the Model list, the new-Conversation check) goes through here rather than the store.
 */
export function resolveCredentials(
  deps: Deps,
  userId: string,
  service: string,
): Promise<Credentials | null> {
  return loadCredentials(deps, userId, service);
}

/** The services the user has usable credentials for, in the order they were added. */
export async function resolvedServices(deps: Deps, userId: string): Promise<string[]> {
  return (await listCredentials(deps, userId)).map((credential) => credential.service);
}

/** What a call to a Model runs with: the credentials, and the output cap when a Host pays. */
export type ModelCall = {
  credentials: Credentials;
  /** Set on a Host Model: bounds the Run (ADR 0007). */
  maxOutputTokens?: number;
  /** Set on a Host Model: its price, which a call on it is recorded with (ADR 0007). */
  hostModel?: HostModel;
};

type ModelDeps = Pick<AppDeps, "db" | "keyEncryptionSecrets" | "hostProviders" | "byok">;

/**
 * The credentials a call to the `"provider:model"` id uses (ADR 0007). The user's own key for its
 * Provider always wins and is never metered; with `byok` off it is ignored. Otherwise the Host's
 * credentials, when the Host offers that Model. `null` when neither applies.
 */
export async function resolveModelCall(
  deps: ModelDeps,
  userId: string,
  id: string,
): Promise<ModelCall | null> {
  const provider = parseModelId(id)?.provider;
  if (!provider) return null;
  if (deps.byok) {
    const own = await resolveCredentials(deps, userId, provider);
    if (own) return { credentials: own };
  }
  const offered = hostEntry(deps, id);
  return offered
    ? {
        credentials: offered.hostProvider.credentials,
        maxOutputTokens: offered.model.maxOutputTokens,
        hostModel: offered.model,
      }
    : null;
}

/** What a Tool call uses: the credentials, and the price of a search when a Host pays for it. */
export type ToolCall = {
  credentials: Credentials;
  /** Set on a Host Tool: each search on it is recorded at this price (ADR 0007). */
  pricePerSearchUsd?: number;
};

type ToolDeps = Pick<AppDeps, "db" | "keyEncryptionSecrets" | "hostTools" | "byok">;

/**
 * The credentials a Tool call uses (ADR 0007), the same rule as a Model's: the user's own Tool
 * credential wins and is never metered; with `byok` off it is ignored. Otherwise the Host's Tool.
 * `null` when neither applies.
 */
export async function resolveToolCall(
  deps: ToolDeps,
  userId: string,
  tool: HostTool["tool"],
): Promise<ToolCall | null> {
  if (deps.byok) {
    const own = await resolveCredentials(deps, userId, tool);
    if (own) return { credentials: own };
  }
  const offered = deps.hostTools.find((entry) => entry.tool === tool);
  return offered
    ? { credentials: offered.credentials, pricePerSearchUsd: offered.pricePerSearchUsd }
    : null;
}

/**
 * The Host's Models as Models. A Model whose id is curated takes its label and capability flags
 * from the curated list, unless the Host states its own.
 */
export function hostModelList(deps: Pick<AppDeps, "hostProviders">): CuratedModel[] {
  return deps.hostProviders.flatMap(({ provider, models }) =>
    models.map((model): CuratedModel => {
      const id = `${provider}:${model.modelId}`;
      const curated = findModel(id);
      return {
        id,
        provider,
        modelId: model.modelId,
        label: model.label ?? curated?.label ?? model.modelId,
        images: model.images ?? curated?.images ?? false,
        pdfs: model.pdfs ?? curated?.pdfs ?? false,
        tools: model.tools ?? curated?.tools ?? false,
        contextWindow: curated?.contextWindow ?? null,
        // The Host's cap is the output bound of every Run on it (ADR 0007), so it is this Model's.
        maxOutputTokens: model.maxOutputTokens,
        reasoning: curated?.reasoning ?? unknownReasoning(),
      };
    }),
  );
}

/** The Host's entry for a `"provider:model"` id, and the Provider it sits under. */
function hostEntry(
  deps: Pick<AppDeps, "hostProviders">,
  id: string,
): { hostProvider: HostProvider; model: HostModel } | undefined {
  for (const hostProvider of deps.hostProviders) {
    const model = hostProvider.models.find(
      (entry) => `${hostProvider.provider}:${entry.modelId}` === id,
    );
    if (model) return { hostProvider, model };
  }
  return undefined;
}
