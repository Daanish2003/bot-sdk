import { z } from "zod";

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
});

export type ChatCommand = z.input<typeof chatCommandSchema>;
