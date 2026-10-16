import { eq } from "drizzle-orm";

import { usage, userCredentials } from "../../../core/server/db/schema";
import type { UserDeleteHooks } from "../../../core/server/plugin";

/**
 * The `models` plugin's part of `sdk.deleteUser` (spec #439): the user's Provider and Tool
 * credentials, and their usage rows, which no Conversation cascades to (a deleted account keeps no
 * Quota history). Nothing is left for after the commit.
 */
export const modelsUserDelete: UserDeleteHooks<void> = {
  before: async (_sdk, { userId, tx }) => {
    await tx.delete(userCredentials).where(eq(userCredentials.userId, userId));
    await tx.delete(usage).where(eq(usage.userId, userId));
  },
  after: async () => {},
};
