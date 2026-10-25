import { deleteConversations, muted } from "./chat/delete-conversations";
import { enabledPlugins, type BotSdkContext, type UserDeleteHooks } from "./plugin";
import { computerUserDelete } from "../../plugins/computer/server/internal";

/**
 * Deletes everything the SDK holds for a user, in one transaction (spec #439): each plugin's
 * `deleteUser.before` in reverse order (the features first) and the Computer's after them all, then the user's Conversations through the core's
 * delete. After the commit: the Conversation delete's hooks, then each plugin's `after`. Calling it again, or for
 * an unknown id, does nothing.
 *
 * Muted: a Host's user delete emits nothing, not even `onConversationDeleted`. The plugins' hooks
 * get an sdk whose events fire nothing.
 */
export async function deleteUserData(given: BotSdkContext, userId: string): Promise<void> {
  const sdk = { ...given, events: muted };
  const plugins: UserDeleteHooks[] = [
    ...[...enabledPlugins(sdk)]
      .reverse()
      .flatMap((plugin) => (plugin.deleteUser ? [plugin.deleteUser] : [])),
    // Last, after the owner checks' locks (see `createRow` in the Computer).
    ...(sdk.computer ? [computerUserDelete] : []),
  ];
  const { collected, afterCommit } = await sdk.db.transaction(async (tx) => {
    const collected: unknown[] = [];
    for (const hooks of plugins) collected.push(await hooks.before(sdk, { userId, tx }));
    const { afterCommit } = await deleteConversations(sdk, tx, { userId, mute: true });
    return { collected, afterCommit };
  });
  await afterCommit();
  for (const [index, hooks] of plugins.entries()) {
    try {
      await hooks.after(sdk, { userId, collected: collected[index] });
    } catch (error) {
      sdk.logger.error("A user delete hook failed after the commit", error);
    }
  }
}

/**
 * A user's export: the core's envelope, and one key per exporting plugin, its plugin id, holding
 * that plugin's part. The core holds the parts as unknown; each plugin types its own.
 */
export type UserExport = { version: 2; exportedAt: Date; [pluginId: string]: unknown };

/**
 * Everything the SDK keeps for a user, as one document, read in one repeatable-read snapshot: the
 * core's `version` and `exportedAt`, and each exporting plugin's part under its plugin id. A plugin
 * that is not installed has no key. An unknown user id gives an empty document, not an error.
 */
export async function exportUserData(sdk: BotSdkContext, userId: string): Promise<UserExport> {
  return sdk.db.transaction(
    async (tx) => {
      const document: UserExport = { version: 2, exportedAt: new Date() };
      for (const plugin of enabledPlugins(sdk)) {
        if (plugin.exportUser) document[plugin.id] = await plugin.exportUser(sdk, userId, tx);
      }
      return document;
    },
    { isolationLevel: "repeatable read" },
  );
}
