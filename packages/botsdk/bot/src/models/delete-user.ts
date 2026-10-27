import { eq } from "drizzle-orm";

import { modelSettings, usage, userCredentials } from "../storage";
import type { UserDeleteHooks } from "../plugin";

/**
 * The `models` plugin's part of `sdk.users.delete` (spec #439): the user's Provider and Tool
 * credentials, their Model settings and their usage rows, which no Conversation cascades to (a
 * deleted account keeps no Quota history). Nothing is left for after the commit.
 */
export const modelsUserDelete: UserDeleteHooks<void> = {
  before: async (_sdk, { userId, tx }) => {
    await tx.delete(userCredentials).where(eq(userCredentials.userId, userId));
    await tx.delete(modelSettings).where(eq(modelSettings.userId, userId));
    await tx.delete(usage).where(eq(usage.userId, userId));
  },
  after: async () => {},
};
