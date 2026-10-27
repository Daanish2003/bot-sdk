import {
  type ImageModel,
  type ListedImageModel,
  curatedImageModels,
  findImageModel,
} from "@botsdk/client/models/image-models";
import { parseModelId } from "@botsdk/client/models/models";

import { type ResolveDeps, resolvePayer } from "./credentials/resolve";
import type { Credentials, HostImageModel } from "./types";
import { type ImageMeter, imageMeter } from "./meter";

type Deps = ResolveDeps;

/** An Image Model the call runs on, with the credentials it uses (spec #278). */
export type ResolvedImageModel = ImageModel & {
  credentials: Credentials;
  /** Set on a Host Image Model: its pinned size and quality. */
  hostModel?: HostImageModel;
  /** Checks the Quota before each image and records it; `onHost` when a Host pays (ADR 0007). */
  meter: ImageMeter;
};

/**
 * A Host Image Model as an Image Model: a curated id takes its label and edit limit from the
 * catalogue; any other id is labelled by its model id and can't edit.
 */
function hostImageModel(provider: ImageModel["provider"], modelId: string): ImageModel {
  const id = `${provider}:${modelId}`;
  const curated = findImageModel(id);
  return {
    id,
    provider,
    modelId,
    label: curated?.label ?? modelId,
    maxInputImages: curated?.maxInputImages ?? 0,
  };
}

/** The Host's Image Models as Image Models. */
export function hostImageModelList(deps: Pick<Deps, "hostProviders">): ImageModel[] {
  return deps.hostProviders.flatMap(({ provider, imageModels = [] }) =>
    imageModels.map((model) => hostImageModel(provider, model.modelId)),
  );
}

/**
 * The Image Models a user can pick, given the Providers they have credentials for (`services`):
 * the curated ones of those Providers first, then the Host's for the other Providers, marked as
 * running on Host credentials. The same rule as chat Models: the user's own key wins (ADR 0007).
 */
export function listImageModels(deps: Pick<Deps, "hostProviders">, services: string[]) {
  const own: ListedImageModel[] = curatedImageModels
    .filter((model) => services.includes(model.provider))
    .map((model) => ({ ...model, onHostCredentials: false }));
  const hosted: ListedImageModel[] = hostImageModelList(deps)
    .filter((model) => !services.includes(model.provider))
    .map((model) => ({ ...model, onHostCredentials: true }));
  return [...own, ...hosted];
}

/**
 * The Image Model for a `"provider:model"` id a user can use, or `undefined`. With the user's own
 * credentials for its Provider, only a curated Model of that Provider resolves; without them, the
 * Host's Image Model with that id. Never picks a Provider on its own.
 */
export async function resolveImageModel(
  deps: Deps,
  userId: string,
  id: string,
): Promise<ResolvedImageModel | undefined> {
  const provider = parseModelId(id)?.provider;
  if (!provider) return undefined;
  const resolved = await resolvePayer(deps, userId, [provider], () => hostImageEntry(deps, id));
  if (!resolved) return undefined;
  if (resolved.payer === "user") {
    const curated = findImageModel(id);
    return curated
      ? {
          ...curated,
          credentials: resolved.credentials,
          meter: imageMeter(deps, userId, { model: id, provider }),
        }
      : undefined;
  }
  const { hostProvider, hostModel } = resolved.offer;
  return {
    ...hostImageModel(hostProvider.provider, hostModel.modelId),
    credentials: hostProvider.credentials,
    hostModel,
    meter: imageMeter(deps, userId, { model: id, provider, price: hostModel }),
  };
}

/** The Host's Image Model with a `"provider:model"` id, and the Provider it sits under. */
function hostImageEntry(deps: Pick<Deps, "hostProviders">, id: string) {
  for (const hostProvider of deps.hostProviders) {
    const hostModel = hostProvider.imageModels?.find(
      (model) => `${hostProvider.provider}:${model.modelId}` === id,
    );
    if (hostModel) return { hostProvider, hostModel };
  }
  return undefined;
}
