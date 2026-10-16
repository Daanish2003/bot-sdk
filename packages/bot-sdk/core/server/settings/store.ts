import { userSettings } from "../db/schema";
import { eq } from "drizzle-orm";

import type { BotSdkContext } from "../plugin";

type Deps = Pick<BotSdkContext, "db">;

export type UserSettings = {
  backgroundModel: string | null;
  imageModel: string | null;
  instructions: string | null;
};

/** The user's settings; the defaults when they never saved any. */
export async function loadSettings(deps: Deps, userId: string): Promise<UserSettings> {
  const [row] = await deps.db
    .select({
      backgroundModel: userSettings.backgroundModel,
      imageModel: userSettings.imageModel,
      instructions: userSettings.instructions,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return {
    backgroundModel: row?.backgroundModel ?? null,
    imageModel: row?.imageModel ?? null,
    instructions: row?.instructions ?? null,
  };
}

/** Saves the Image Model (`null`: the Host's default Image Model, or none). */
export async function saveImageModel(deps: Deps, userId: string, imageModel: string | null) {
  await deps.db
    .insert(userSettings)
    .values({ userId, imageModel })
    .onConflictDoUpdate({ target: userSettings.userId, set: { imageModel } });
}

/** Saves the Instructions, trimmed; blank means none (`null`). The caller checks the limit. */
export async function saveInstructions(deps: Deps, userId: string, instructions: string | null) {
  const stored = instructions?.trim() || null;
  await deps.db
    .insert(userSettings)
    .values({ userId, instructions: stored })
    .onConflictDoUpdate({ target: userSettings.userId, set: { instructions: stored } });
}

/** Saves the Background Model (`null`: the Model that wrote the first reply). */
export async function saveBackgroundModel(
  deps: Deps,
  userId: string,
  backgroundModel: string | null,
) {
  await deps.db
    .insert(userSettings)
    .values({ userId, backgroundModel })
    .onConflictDoUpdate({ target: userSettings.userId, set: { backgroundModel } });
}
