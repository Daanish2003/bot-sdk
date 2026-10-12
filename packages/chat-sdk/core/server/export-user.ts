import { and, asc, eq, inArray } from "drizzle-orm";

import { attachment, messageAttachment } from "./db/schema/attachment";
import { conversation, message, project } from "./db/schema/chat";
import { sharedLink } from "./db/schema/share";
import { userSettings } from "./db/schema/settings";
import type { AppDeps } from "./deps";
import type { StoredParts } from "../shared/message-parts";

/**
 * Everything the SDK keeps for one user, as one JSON-ready document (`chat.exportUser`). Provider
 * and Tool credentials are never in it, and an Attachment appears by name and type only. Usage
 * rows are left out: they are the Quota's record, not the user's data.
 */
export type UserExport = {
  /** The format version. Bumped only when a reader would misread the document. */
  version: 1;
  exportedAt: Date;
  settings: { titleModel: string | null; instructions: string | null };
  projects: {
    id: string;
    name: string;
    instructions: string | null;
    defaultModel: string | null;
    createdAt: Date;
  }[];
  conversations: {
    id: string;
    title: string | null;
    model: string;
    reasoningEffort: string | null;
    projectId: string | null;
    pinnedAt: Date | null;
    /** The newest Message of the Active Branch. */
    activeLeafId: string | null;
    lastMessageAt: Date;
    createdAt: Date;
    /** Every Message of the Conversation, every Branch; the parent chain gives the tree. */
    messages: {
      id: string;
      parentId: string | null;
      role: "user" | "assistant";
      parts: StoredParts;
      model: string | null;
      status: string;
      createdAt: Date;
      attachments: { filename: string; mediaType: string }[];
    }[];
  }[];
  /** The user's Shared links: the token, the Conversation it shares and when it was shared. */
  sharedLinks: { token: string; conversationId: string; createdAt: Date }[];
};

/**
 * Reads the user's data in one repeatable-read snapshot and builds the document in memory. An
 * unknown user id gives an empty document, not an error.
 */
export async function exportUserData(deps: AppDeps, userId: string): Promise<UserExport> {
  return deps.db.transaction(
    async (tx) => {
      const [settings] = await tx
        .select({ titleModel: userSettings.titleModel, instructions: userSettings.instructions })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

      const projects = await tx
        .select({
          id: project.id,
          name: project.name,
          instructions: project.instructions,
          defaultModel: project.defaultModel,
          createdAt: project.createdAt,
        })
        .from(project)
        .where(eq(project.userId, userId))
        .orderBy(asc(project.createdAt), asc(project.id));

      const conversations = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.userId, userId))
        .orderBy(asc(conversation.createdAt), asc(conversation.id));

      const messages = (
        await tx
          .select({ message })
          .from(message)
          .innerJoin(conversation, eq(conversation.id, message.conversationId))
          .where(eq(conversation.userId, userId))
          .orderBy(asc(message.createdAt), asc(message.id))
      ).map((row) => row.message);

      const messageIds = messages.map((row) => row.id);
      const attachments = messageIds.length
        ? await tx
            .select({
              messageId: messageAttachment.messageId,
              filename: attachment.filename,
              mediaType: attachment.mediaType,
            })
            .from(messageAttachment)
            .innerJoin(attachment, eq(attachment.id, messageAttachment.attachmentId))
            .where(
              and(inArray(messageAttachment.messageId, messageIds), eq(attachment.userId, userId)),
            )
            .orderBy(asc(messageAttachment.position))
        : [];

      const links = await tx
        .select({
          token: sharedLink.token,
          conversationId: sharedLink.conversationId,
          createdAt: sharedLink.createdAt,
        })
        .from(sharedLink)
        .innerJoin(conversation, eq(conversation.id, sharedLink.conversationId))
        .where(eq(conversation.userId, userId));

      const attachmentsByMessage = groupBy(attachments, (row) => row.messageId);
      const messagesByConversation = groupBy(messages, (row) => row.conversationId);

      return {
        version: 1,
        exportedAt: new Date(),
        settings: {
          titleModel: settings?.titleModel ?? null,
          instructions: settings?.instructions ?? null,
        },
        projects,
        conversations: conversations.map((conv) => ({
          id: conv.id,
          title: conv.title,
          model: conv.model,
          reasoningEffort: conv.reasoningEffort,
          projectId: conv.projectId,
          pinnedAt: conv.pinnedAt,
          activeLeafId: conv.activeLeafId,
          lastMessageAt: conv.lastMessageAt,
          createdAt: conv.createdAt,
          messages: (messagesByConversation.get(conv.id) ?? []).map((row) => ({
            id: row.id,
            parentId: row.parentId,
            role: row.role,
            parts: row.parts,
            model: row.model,
            status: row.status,
            createdAt: row.createdAt,
            attachments: (attachmentsByMessage.get(row.id) ?? []).map(
              ({ filename, mediaType }) => ({
                filename,
                mediaType,
              }),
            ),
          })),
        })),
        sharedLinks: links,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

// `Map.groupBy` is ES2024, newer than some Hosts' TypeScript lib.
function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}
