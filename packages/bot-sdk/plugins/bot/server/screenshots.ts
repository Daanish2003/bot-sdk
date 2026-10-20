import { eq, inArray } from "drizzle-orm";

import { deleteBlobsBestEffort } from "../../../core/server/blob/store";
import { bot, botHelper, botHelperScreenshot } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, ConversationDeleteHooks } from "../../../core/server/plugin";

/** The blob key of a Helper's screenshot (#608). */
export const screenshotBlobKey = (screenshotId: string) => `screenshot/${screenshotId}`;

/**
 * Stores one of Helper `helperId`'s screenshots: its row, then its PNG in the blob store, so a
 * row never lacks the key its bytes may sit under. Returns its id.
 */
export async function storeScreenshot(
  deps: Pick<BotSdkContext, "db" | "blobStore" | "clock">,
  helperId: string,
  png: Uint8Array,
): Promise<string> {
  const id = uuidv7();
  await deps.db.insert(botHelperScreenshot).values({ id, helperId, createdAt: deps.clock() });
  await deps.blobStore.put(screenshotBlobKey(id), png, { contentType: "image/png" });
  return id;
}

/**
 * The bot plugin's hooks on every Conversation delete: a Bot goes with its Conversation, and its
 * Helpers' screenshots with it. Their rows go by cascade, so `before` reads their keys inside the
 * delete's transaction, and `after` deletes their bytes once it commits (ADR 0015).
 */
export const screenshotsConversationDelete: ConversationDeleteHooks<string[]> = {
  before: async (_sdk, { conversationIds, tx }) => {
    const rows = await tx
      .select({ id: botHelperScreenshot.id })
      .from(botHelperScreenshot)
      .innerJoin(botHelper, eq(botHelper.id, botHelperScreenshot.helperId))
      .innerJoin(bot, eq(bot.id, botHelper.botId))
      .where(inArray(bot.conversationId, conversationIds));
    return rows.map((row) => screenshotBlobKey(row.id));
  },
  after: (sdk, { collected }) => deleteBlobsBestEffort(sdk, collected),
};
