import { eq } from "drizzle-orm";

import { pathTo } from "../../shared/chat/branches";
import { message, type MessageRow } from "../db/schema";
import type { BotSdkContext } from "../plugin";

type Deps = Pick<BotSdkContext, "db">;

/** Every Message of the Conversation, on every Branch, in no order. */
export function loadMessages(deps: Deps, conversationId: string) {
  return deps.db.select().from(message).where(eq(message.conversationId, conversationId));
}

/** The Messages from a root down to `leafId`, oldest first. Empty without a leaf. */
export async function loadPath(
  deps: Deps,
  conversationId: string,
  leafId: string | null,
): Promise<MessageRow[]> {
  if (!leafId) return [];
  return pathTo(await loadMessages(deps, conversationId), leafId);
}
