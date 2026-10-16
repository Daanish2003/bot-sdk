import { inArray } from "drizzle-orm";

import { deleteBlobsBestEffort } from "../../../../core/server/blob/store";
import type { RunEndEvent } from "../../../../core/server/chat/hooks";
import { message } from "../../../../core/server/db/schema";
import type { ConversationDeleteHooks } from "../../../../core/server/plugin";
import { generatedImageKeysWhere, imagesOfMessages } from "./generated-image-store";
import { stopConversationRuns } from "./run";

/**
 * The assistant's hooks on every Conversation delete. `before` stops the live Runs in them through
 * the Stop path (their owners write nothing more once the rows are gone) and reads their Generated
 * images' keys, whose rows go by cascade. `after` deletes those bytes and fires `onRunEnd` for the
 * Runs that ended without their owner (#265).
 */
export const assistantConversationDelete: ConversationDeleteHooks<{
  ended: RunEndEvent[];
  blobKeys: string[];
}> = {
  before: async (sdk, { conversationIds, tx }) => ({
    ended: await stopConversationRuns(sdk, conversationIds, tx),
    blobKeys: await generatedImageKeysWhere(
      tx,
      imagesOfMessages(tx, inArray(message.conversationId, conversationIds)),
    ),
  }),
  after: async (sdk, { collected }) => {
    await deleteBlobsBestEffort(sdk, collected.blobKeys);
    for (const run of collected.ended) sdk.events.fire("onRunEnd", run);
  },
};
