import { eq } from "drizzle-orm";

import { conversation } from "../../../../core/server/db/schema";

/** The `kind` of every Conversation the assistant owns: its plugin id. */
export const assistantKind = "assistant";

/** Matches the assistant's own Conversations; another plugin's (a Bot's) are not the assistant's to see. */
export const assistantConversation = () => eq(conversation.kind, assistantKind);

/**
 * An assistant Conversation's row with its `model` typed as set. The column is nullable only for
 * other plugins' Conversations; a CHECK keeps it set on every assistant one.
 */
export function withModel<T extends { model: string | null }>(row: T): T & { model: string } {
  return row as T & { model: string };
}
