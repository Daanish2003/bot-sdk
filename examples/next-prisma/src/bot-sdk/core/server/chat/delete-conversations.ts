import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { conversation } from "../db/schema";
import { enabledPlugins, type BotSdkContext, type Transaction } from "../plugin";
import { withProjectId, type HookEmitter } from "./hooks";

/** An emitter that fires nothing, for a delete the Host hears nothing about. */
export const muted = (events: HookEmitter): HookEmitter => ({
  fire: () => {},
  moderate: events.moderate,
});

/**
 * Deletes the Conversations `where` matches (the user's only, unless `userId` is `null`, which
 * requires a `where`) inside the caller's transaction (spec #439). Every path that removes Conversations calls it before deleting
 * any parent. It selects the ids, runs every plugin's `before`, then deletes the rows; their Messages
 * and the rest go by cascade. It repeats until the select finds none, so a Conversation committed
 * between a select and its delete goes too, through the hooks.
 *
 * Call `afterCommit` once the transaction commits: it runs every plugin's `after` (once per pass),
 * then fires `onConversationDeleted` for each Conversation when `announce` is given (with the
 * Project from `announce.projectId`). `mute` keeps every Host event of the delete, the hooks' too,
 * from firing.
 */
export async function deleteConversations(
  sdk: BotSdkContext,
  tx: Transaction,
  {
    where,
    userId,
    announce,
    mute = false,
  }: ({ where: SQL; userId: null } | { where?: SQL; userId: string }) & {
    announce?: { projectId?: AnyColumn };
    mute?: boolean;
  },
): Promise<{ deleted: string[]; afterCommit: () => Promise<void> }> {
  const hooks = enabledPlugins(sdk).flatMap((plugin) => {
    const hook = plugin.databaseHooks?.conversation?.delete;
    return hook ? [hook] : [];
  });
  const rows: { id: string; userId: string; projectId: string | null }[] = [];
  const passes: { conversationIds: string[]; collected: unknown[] }[] = [];
  for (;;) {
    const found = await tx
      .select({
        id: conversation.id,
        userId: conversation.userId,
        // The column the caller names for the event's Project, or none.
        projectId: announce?.projectId
          ? sql<string | null>`${announce.projectId}`
          : sql<null>`null`,
      })
      .from(conversation)
      .where(and(where, userId === null ? undefined : eq(conversation.userId, userId)));
    if (found.length === 0) break;
    const conversationIds = found.map((row) => row.id);
    const collected: unknown[] = [];
    for (const hook of hooks) {
      collected.push(await hook.before(sdk, { conversationIds, userId, tx }));
    }
    await tx.delete(conversation).where(inArray(conversation.id, conversationIds));
    rows.push(...found);
    passes.push({ conversationIds, collected });
  }
  if (rows.length === 0) return { deleted: [], afterCommit: async () => {} };

  const hookSdk = mute ? { ...sdk, events: muted(sdk.events) } : sdk;
  return {
    deleted: rows.map((row) => row.id),
    afterCommit: async () => {
      for (const { conversationIds, collected } of passes) {
        for (const [index, hook] of hooks.entries()) {
          try {
            await hook.after(hookSdk, { conversationIds, userId, collected: collected[index] });
          } catch (error) {
            sdk.logger.error("A Conversation delete hook failed after the commit", error);
          }
        }
      }
      if (!announce || mute) return;
      for (const row of rows) {
        sdk.events.fire("onConversationDeleted", {
          userId: row.userId,
          conversationId: row.id,
          ...withProjectId(row.projectId),
        });
      }
    },
  };
}
