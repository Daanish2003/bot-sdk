import type { UserExport } from "../../plugins/assistant/server/export-user";
import { eq } from "drizzle-orm";

import { deleteUnusedAttachments } from "./attachments/store";
import { attachment } from "./db/schema";
import { deleteBlobsBestEffort } from "./blob/store";
import { deleteConversations, muted } from "./chat/delete-conversations";
import { enabledPlugins, type BotSdkContext } from "./plugin";

/**
 * Deletes everything the SDK holds for a user, in one transaction (spec #439): each plugin's
 * `deleteUser.before` in reverse dependency order, then the user's Conversations through the core's
 * delete, then their attachments and Postgres bytes. After the commit: the Conversation delete's
 * hooks, the attachments' bytes in the store, then each plugin's `after`. Calling it again, or for
 * an unknown id, does nothing.
 *
 * Muted: a Host's user delete emits nothing, not even `onRunEnd` (#265). The plugins' hooks get an
 * sdk whose events fire nothing.
 */
export async function deleteUserData(given: BotSdkContext, userId: string): Promise<void> {
  const sdk = { ...given, events: muted(given.events) };
  const plugins = [...enabledPlugins(sdk)]
    .reverse()
    .flatMap((plugin) => (plugin.deleteUser ? [plugin.deleteUser] : []));
  const { collected, afterCommit, blobKeys } = await sdk.db.transaction(async (tx) => {
    const collected: unknown[] = [];
    for (const hooks of plugins) collected.push(await hooks.before(sdk, { userId, tx }));
    // Before the attachments: a Message's link to an attachment does not cascade.
    const { afterCommit } = await deleteConversations(sdk, tx, { userId, mute: true });
    // With their Messages gone, none of the user's attachments is used any more.
    const own = await tx
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.userId, userId));
    const blobKeys = await deleteUnusedAttachments(
      tx,
      own.map((row) => row.id),
    );
    return { collected, afterCommit, blobKeys };
  });
  await afterCommit();
  await deleteBlobsBestEffort(sdk, blobKeys);
  for (const [index, hooks] of plugins.entries()) {
    try {
      await hooks.after(sdk, { userId, collected: collected[index] });
    } catch (error) {
      sdk.logger.error("A user delete hook failed after the commit", error);
    }
  }
}

/**
 * Everything the SDK keeps for a user, as one document, read in one repeatable-read snapshot: the
 * core's `version` and `exportedAt`, and each plugin's part. A key two plugins give throws. An
 * unknown user id gives an empty document, not an error.
 *
 * `UserExport` is the document with every plugin of the package enabled; an instance without a
 * plugin leaves that plugin's keys out.
 */
export async function exportUserData(sdk: BotSdkContext, userId: string): Promise<UserExport> {
  return sdk.db.transaction(
    async (tx) => {
      const document: Partial<UserExport> = { version: 1, exportedAt: new Date() };
      const owners = new Map<string, string>([
        ["version", "core"],
        ["exportedAt", "core"],
      ]);
      for (const plugin of enabledPlugins(sdk)) {
        const part = await plugin.exportUser?.(sdk, userId, tx);
        for (const key of Object.keys(part ?? {})) {
          const owner = owners.get(key);
          if (owner) throw new Error(`"${key}" is exported by both "${owner}" and "${plugin.id}"`);
          owners.set(key, plugin.id);
        }
        Object.assign(document, part);
      }
      // The merge can't be typed: which keys are present depends on the enabled plugins (see above).
      return document as UserExport;
    },
    { isolationLevel: "repeatable read" },
  );
}
