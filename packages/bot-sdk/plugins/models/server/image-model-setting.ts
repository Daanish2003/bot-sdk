import { eq } from "drizzle-orm";

import { modelSettings } from "../../../core/server/db/schema";
import { resolveImageModel, type ResolvedImageModel } from "./image-models";
import type { ModelsDeps } from "./types";

/** The user's Image Model pick, or `null` for the Host's default (`model_settings`, spec #801). */
export async function loadImageModelSetting(
  deps: Pick<ModelsDeps, "db">,
  userId: string,
): Promise<string | null> {
  const [row] = await deps.db
    .select({ imageModel: modelSettings.imageModel })
    .from(modelSettings)
    .where(eq(modelSettings.userId, userId));
  return row?.imageModel ?? null;
}

/** Saves the Image Model (`null`: the Host's default Image Model, or none). The caller checks it. */
export async function saveImageModelSetting(
  deps: Pick<ModelsDeps, "db">,
  userId: string,
  imageModel: string | null,
) {
  await deps.db
    .insert(modelSettings)
    .values({ userId, imageModel })
    .onConflictDoUpdate({ target: modelSettings.userId, set: { imageModel } });
}

/**
 * The Image Model a call on the user's behalf uses: their saved pick, else the Host's default
 * Image Model, else none (`null`). A pick the user can no longer use (its key was removed) gives
 * none too; the Host default isn't used in its place.
 */
export async function resolveUserImageModel(
  deps: ModelsDeps,
  userId: string,
): Promise<ResolvedImageModel | null> {
  const id = (await loadImageModelSetting(deps, userId)) ?? deps.defaultImageModel;
  if (!id) return null;
  return (await resolveImageModel(deps, userId, id)) ?? null;
}
