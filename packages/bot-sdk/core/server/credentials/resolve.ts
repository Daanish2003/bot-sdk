import {
  findModel,
  parseModelId,
  type CuratedModel,
  unknownReasoning,
} from "../../shared/chat/models";
import {
  freeMeter,
  hostModelMeter,
  hostSearchMeter,
  type ModelMeter,
  type SearchMeter,
} from "../chat/meter";
import type { AppDeps, Credentials, HostModel, HostProvider, HostTool } from "../deps";
import { listCredentials, loadCredentials } from "./store";

/** What resolving a paid call reads: the user's keys and the Host's offers, and what a meter writes. */
export type ResolveDeps = Pick<
  AppDeps,
  | "db"
  | "keyEncryptionSecrets"
  | "byok"
  | "hostProviders"
  | "hostTools"
  | "hooks"
  | "getQuota"
  | "logger"
>;

/** The services the user has usable credentials for, in the order they were added. */
export async function resolvedServices(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets">,
  userId: string,
): Promise<string[]> {
  return (await listCredentials(deps, userId)).map((credential) => credential.service);
}

/** Who pays for a call: the user, on their own credentials for `service`, or the Host, on its offer. */
export type Payer<Offer> =
  | { payer: "user"; service: string; credentials: Credentials }
  | { payer: "host"; offer: Offer };

/**
 * The one rule that decides who pays for a paid call (ADR 0007), for Models, Tools, Image Models,
 * embedding Models and transcription alike: with `byok` on, the user's own credentials for the
 * first of `services` they have win, and are never metered; otherwise the Host's offer, which
 * `hostOffer` looks up for each kind of call. `null` when neither applies.
 */
export async function resolvePayer<Offer>(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets" | "byok">,
  userId: string,
  services: readonly string[],
  hostOffer: () => Offer | null | undefined,
): Promise<Payer<Offer> | null> {
  if (deps.byok) {
    for (const service of services) {
      const credentials = await loadCredentials(deps, userId, service);
      if (credentials) return { payer: "user", service, credentials };
    }
  }
  const offer = hostOffer();
  return offer ? { payer: "host", offer } : null;
}

/** What a call to a Model runs with: the credentials, its meter, and the output cap when a Host pays. */
export type ModelCall = {
  credentials: Credentials;
  /** Set on a Host Model: bounds the Run (ADR 0007). */
  maxOutputTokens?: number;
  /** Checks the Quota before the call and records it: the free meter on the user's own key. */
  meter: ModelMeter;
};

/**
 * The credentials a call to the `"provider:model"` id uses (`resolvePayer`): the user's own key for
 * its Provider, else the Host's credentials when the Host offers that Model, metered at its price.
 * `null` when neither applies.
 */
export async function resolveModelCall(
  deps: ResolveDeps,
  userId: string,
  id: string,
): Promise<ModelCall | null> {
  const provider = parseModelId(id)?.provider;
  if (!provider) return null;
  const resolved = await resolvePayer(deps, userId, [provider], () => hostEntry(deps, id));
  if (!resolved) return null;
  if (resolved.payer === "user") return { credentials: resolved.credentials, meter: freeMeter };
  const { hostProvider, model } = resolved.offer;
  return {
    credentials: hostProvider.credentials,
    maxOutputTokens: model.maxOutputTokens,
    meter: hostModelMeter(deps, userId, id, model),
  };
}

/** What a Tool call uses: the credentials, and the meter that prices each search on the Host's Tool. */
export type ToolCall = { credentials: Credentials; meter: SearchMeter };

/**
 * The credentials a Tool call uses (`resolvePayer`), the same rule as a Model's: the user's own Tool
 * credential, else the Host's Tool, metered at its price per search. `null` when neither applies.
 */
export async function resolveToolCall(
  deps: ResolveDeps,
  userId: string,
  tool: HostTool["tool"],
): Promise<ToolCall | null> {
  const resolved = await resolvePayer(deps, userId, [tool], () =>
    deps.hostTools.find((entry) => entry.tool === tool),
  );
  if (!resolved) return null;
  if (resolved.payer === "user") return { credentials: resolved.credentials, meter: freeMeter };
  return {
    credentials: resolved.offer.credentials,
    meter: hostSearchMeter(deps, userId, resolved.offer.pricePerSearchUsd),
  };
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
