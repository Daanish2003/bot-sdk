import { userSettings } from "../db/schema/settings";
import { eq } from "drizzle-orm";

import type { AppDeps } from "../deps";

type Deps = Pick<AppDeps, "db">;

export type UserSettings = { titleModel: string | null; instructions: string | null };

/** The user's settings; the defaults when they never saved any. */
export async function loadSettings(deps: Deps, userId: string): Promise<UserSettings> {
  const [row] = await deps.db
    .select({ titleModel: userSettings.titleModel, instructions: userSettings.instructions })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return { titleModel: row?.titleModel ?? null, instructions: row?.instructions ?? null };
}

/** Saves the Instructions, trimmed; blank means none (`null`). The caller checks the limit. */
export async function saveInstructions(deps: Deps, userId: string, instructions: string | null) {
  const stored = instructions?.trim() || null;
  await deps.db
    .insert(userSettings)
    .values({ userId, instructions: stored })
    .onConflictDoUpdate({ target: userSettings.userId, set: { instructions: stored } });
}

/** Saves the Title Model (`null`: the Model that wrote the first reply). */
export async function saveTitleModel(deps: Deps, userId: string, titleModel: string | null) {
  await deps.db
    .insert(userSettings)
    .values({ userId, titleModel })
    .onConflictDoUpdate({ target: userSettings.userId, set: { titleModel } });
}
