import type { AttachmentInfo } from "../../../../core/shared/attachments/kinds";
import type { MessageRecord } from "../../../../core/shared/chat/message-record";
import { parseStoredParts, toUIParts } from "../chat/parts";
import { redactAttachmentsForShare, redactForShare } from "./redact";

/**
 * What anyone with the token sees: the token itself (so a viewer can continue the Conversation), the
 * frozen title, the share date and the shared Branch, with thinking and file contents stripped
 * (attachments are filename chips) and no author or error details.
 */
export function toSharedConversation(
  link: { token: string; title: string; updatedAt: Date },
  path: MessageRecord[],
  attachments: Map<string, AttachmentInfo[]>,
) {
  return {
    token: link.token,
    title: link.title,
    sharedAt: link.updatedAt,
    messages: path.map((row) => ({
      id: row.id,
      role: row.role,
      parts: redactForShare(toUIParts(parseStoredParts(row.parts))),
      attachments: redactAttachmentsForShare(attachments.get(row.id) ?? []),
      model: row.model,
      status: row.status,
      /** A Hidden reply has no parts left to show; the viewer sees only that it was hidden (#268). */
      hidden: row.hiddenAt !== null,
      createdAt: row.createdAt,
    })),
  };
}

export type SharedConversation = ReturnType<typeof toSharedConversation>;
