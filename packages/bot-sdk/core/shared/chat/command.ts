import { z } from "zod";

import { conversationToolsSchema } from "./conversation-tools";

/**
 * What the client asks for: a command, never history (ADR 0001). History is rebuilt from the
 * database by walking up from `parentId`. `useChat` sends it as the AG-UI `forwardedProps`.
 */
export const chatCommandSchema = z.object({
  conversationId: z.uuid(),
  /** The Message the new one continues; `null` starts at the root. */
  parentId: z.uuid().nullable(),
  /** The user's text. Without it the command is a regenerate. */
  text: z.string().trim().min(1).optional(),
  /**
   * The new Message's attachments, uploaded first through `attachment.upload`. On an edit this
   * is the whole list: the client carries the edited Message's attachments over. A regenerate
   * takes none; it leaves its user Message's attachments alone.
   */
  attachmentIds: z.array(z.uuid()).default([]),
  /** `"provider:model"` */
  model: z.string(),
  webSearch: z.boolean().default(false),
  /**
   * The MCP tools the composer has switched on. Sent with the first Message only: a Conversation
   * with no Message yet takes them, and later sends use the stored choice (spec #91).
   */
  tools: conversationToolsSchema.optional(),
});

export type ChatCommand = z.input<typeof chatCommandSchema>;
