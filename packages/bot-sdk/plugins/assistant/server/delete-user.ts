import { eq } from "drizzle-orm";

import { deleteConversations } from "../../../core/server/chat/delete-conversations";
import {
  conversation,
  project,
  mcpConnection,
  savedPrompt,
  userSettings,
} from "../../../core/server/db/schema";
import type { BotSdkContext, UserDeleteHooks } from "../../../core/server/plugin";
import { assistantConversation } from "./chat/kind";

/**
 * The assistant's part of `sdk.deleteUser` (spec #439). `before` deletes the user's Projects, MCP
 * connections, settings and Saved prompts. `after` runs the Conversation delete's hooks.
 *
 * Every Conversation of the user goes first, in one call of the core's delete, so its hooks see the
 * whole set and no Project's Conversation goes by cascade alone. The core's own Conversation step
 * then finds none left.
 */
export const assistantUserDelete: UserDeleteHooks<{ afterCommit: () => Promise<void> }> = {
  before: async (sdk, { userId, tx }) => {
    // Muted, as the rest of the user delete is (#265).
    const { afterCommit } = await deleteConversations(sdk, tx, { userId, mute: true });
    await tx.delete(project).where(eq(project.userId, userId));
    await tx.delete(mcpConnection).where(eq(mcpConnection.userId, userId));
    await tx.delete(userSettings).where(eq(userSettings.userId, userId));
    await tx.delete(savedPrompt).where(eq(savedPrompt.userId, userId));
    return { afterCommit };
  },
  after: async (_sdk, { collected }) => {
    await collected.afterCommit();
  },
};

/**
 * Deletes every assistant Conversation the user owns, Project ones included, in one transaction. Their
 * Messages, Shared links and Message–Attachment links go with them. The Projects stay, empty, and
 * so do the Attachments, which a Conversation's delete never removed (the reaper takes unused ones).
 * Live Runs in them stop, through the delete hooks.
 */
export async function deleteAllConversations(deps: BotSdkContext, userId: string): Promise<void> {
  const { afterCommit } = await deps.db.transaction((tx) =>
    deleteConversations(deps, tx, {
      where: assistantConversation(),
      userId,
      announce: { projectId: conversation.projectId },
    }),
  );
  // After the commit: a rolled-back delete fires nothing (#265, #266).
  await afterCommit();
}
