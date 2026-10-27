import { chatgptPlanModels } from "@botsdk/client/models/credentials/services";
import {
  canUseComputer,
  findModel,
  parseModelId,
  type CuratedModel,
  unknownReasoning,
} from "@botsdk/client/models/models";

import {
  freeMeter,
  hostModelMeter,
  hostSearchMeter,
  type ModelMeter,
  type TxMeter,
} from "../meter";
import type { ModelsDeps, Credentials, HostModel, HostProvider, HostTool } from "../types";
import { listCredentials, loadCredentials } from "./store";

/** What resolving a paid call reads: the user's keys and the Host's offers, and what a meter writes. */
export type ResolveDeps = Pick<
  ModelsDeps,
  | "db"
  | "keyEncryptionSecrets"
  | "byok"
  | "linkedCredentials"
  | "hostProviders"
  | "hostTools"
  | "hooks"
  | "getQuota"
  | "logger"
>;

/** The services the user has usable credentials for, in the order they were added. */
export async function resolvedServices(
  deps: Pick<ModelsDeps, "db" | "keyEncryptionSecrets">,
  userId: string,
): Promise<string[]> {
  return (await listCredentials(deps, userId)).map((credential) => credential.service);
}

/** Who pays for a call: the user, on their own credentials for `service`, or the Host, on its offer. */
export type Payer<Offer> =
  | { payer: "user"; service: string; credentials: Credentials }
  | { payer: "host"; offer: Offer };

/**
 * The one rule that decides who pays for a paid call (ADR 0007), for Models, Tools and Image Models
 * alike: with `byok` on, the user's own credentials for the
 * first of `services` they have win, and are never metered; otherwise the Host's offer, which
 * `hostOffer` looks up for each kind of call. `null` when neither applies.
 */
export async function resolvePayer<Offer>(
  deps: Pick<ModelsDeps, "db" | "keyEncryptionSecrets" | "byok">,
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
  /**
   * Set on a linked ChatGPT plan (ADR 0023): `"plan"` runs the call the plan's way, and
   * `"needs-reconnect"` fails it asking the user to reconnect, never falling back to the Host.
   */
  linked?: "plan" | "needs-reconnect";
};

/**
 * The credentials a call to the `"provider:model"` id uses (`resolvePayer`): the user's own key for
 * its Provider, else their linked plan for a Model it offers (ADR 0023), else the Host's
 * credentials when the Host offers that Model, metered at its price. `null` when none applies.
 */
export async function resolveModelCall(
  deps: ResolveDeps,
  userId: string,
  id: string,
): Promise<ModelCall | null> {
  const provider = parseModelId(id)?.provider;
  if (!provider) return null;
  const resolved = await resolvePayer(deps, userId, [provider], () => hostEntry(deps, id));
  if (resolved?.payer === "user") return { credentials: resolved.credentials, meter: freeMeter };
  // No stored credentials: a linked plan comes before the Host's credentials (ADR 0023).
  const linked = await linkedModelCall(deps, userId, id);
  if (linked) return linked;
  if (!resolved) return null;
  const { hostProvider, model } = resolved.offer;
  return {
    credentials: hostProvider.credentials,
    maxOutputTokens: model.maxOutputTokens,
    meter: hostModelMeter(deps, userId, id, model),
  };
}

/**
 * The user's linked ChatGPT plan for a Model it offers (ADR 0023): paid by the user, so the free
 * meter and no output cap. `null` with `byok` off, without the Host's hook, for any other Model, or
 * when nothing is linked.
 */
async function linkedModelCall(
  deps: Pick<ModelsDeps, "byok" | "linkedCredentials">,
  userId: string,
  id: string,
): Promise<ModelCall | null> {
  if (!chatgptPlanModels.includes(id)) return null;
  const linked = await linkedPlan(deps, userId);
  if (!linked) return null;
  if (linked === "needs-reconnect") {
    return { credentials: {}, meter: freeMeter, linked: "needs-reconnect" };
  }
  return { credentials: linked, meter: freeMeter, linked: "plan" };
}

/**
 * What the Host's hook says of the user's linked ChatGPT plan (ADR 0023): its credentials,
 * `"needs-reconnect"`, or `null` when nothing is linked, the Host has no hook, or `byok` is off.
 * The caller decides whether a stored OpenAI key comes first.
 */
export async function linkedPlan(
  deps: Pick<ModelsDeps, "byok" | "linkedCredentials">,
  userId: string,
): Promise<Credentials | "needs-reconnect" | null> {
  if (!deps.byok || !deps.linkedCredentials) return null;
  return (await deps.linkedCredentials(userId, "openai")) ?? null;
}

/**
 * {@link linkedPlan} for what the user is shown (the Model picker, the Keys page): a failing hook
 * is logged and shown as no link, so those pages keep working. A Model call still fails with it.
 */
export async function shownLinkedPlan(
  deps: Pick<ModelsDeps, "byok" | "linkedCredentials" | "logger">,
  userId: string,
): Promise<Credentials | "needs-reconnect" | null> {
  try {
    return await linkedPlan(deps, userId);
  } catch (error) {
    deps.logger.error("The Host's linkedCredentials hook failed", error);
    return null;
  }
}

/** What a Tool call uses: the credentials, and the meter that prices each search on the Host's Tool. */
export type ToolCall = { credentials: Credentials; meter: TxMeter<void> };

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
export function hostModelList(deps: Pick<ModelsDeps, "hostProviders">): CuratedModel[] {
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
        computerUse: canUseComputer(provider),
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
  deps: Pick<ModelsDeps, "hostProviders">,
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
