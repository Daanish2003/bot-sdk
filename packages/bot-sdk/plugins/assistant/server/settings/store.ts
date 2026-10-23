import { userSettings } from "../../../../core/server/db/schema";
import { eq } from "drizzle-orm";

import type { BotSdkContext } from "../../../../core/server/plugin";

type Deps = Pick<BotSdkContext, "db">;

export type UserSettings = {
  backgroundModel: string | null;
  instructions: string | null;
};

/** The user's settings; the defaults when they never saved any. The Image Model is the models plugin's. */
export async function loadSettings(deps: Deps, userId: string): Promise<UserSettings> {
  const [row] = await deps.db
    .select({
      backgroundModel: userSettings.backgroundModel,
      instructions: userSettings.instructions,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return {
    backgroundModel: row?.backgroundModel ?? null,
    instructions: row?.instructions ?? null,
  };
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
