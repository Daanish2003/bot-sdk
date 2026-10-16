import { and, asc, eq, inArray } from "drizzle-orm";

import {
  artifact,
  artifactVersion,
  attachment,
  messageAttachment,
  conversation,
  message,
  project,
  generatedImage,
  knowledgeFile,
  savedPrompt,
  sharedLink,
  memory,
  userSettings,
} from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { liveConversation } from "./chat/temporary";
import type { ArtifactKind } from "../shared/chat/artifact";
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
  settings: {
    backgroundModel: string | null;
    imageModel: string | null;
    instructions: string | null;
    /** Whether the assistant uses and makes Memories for the user (ADR 0013). */
    memoryEnabled: boolean;
  };
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
    /** A Temporary Conversation (spec #262); the export holds the ones that still exist. */
    temporary: boolean;
    /** When the Conversation was archived; null when it is not. */
    archivedAt: Date | null;
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
      /** The owner's Rating; always null on a user Message, which can't be rated. */
      rating: "up" | "down" | null;
      /** A Hidden reply (#268): its parts are empty, and the export says only that it was hidden. */
      hidden: boolean;
      createdAt: Date;
      attachments: { filename: string; mediaType: string }[];
      /** The Generated images the reply made: by id, the Image Model and the prompt, never the bytes. */
      generatedImages: { id: string; model: string; prompt: string | null }[];
    }[];
  }[];
  /** Every Memory the user has, valid and outdated: the source Conversation and what replaced it. */
  memories: {
    id: string;
    text: string;
    origin: "extracted" | "said";
    conversationId: string;
    replacedById: string | null;
    /** When the Memory was outdated; null while it is valid. */
    invalidAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
  /** The user's Shared links: the token, the Conversation it shares and when it was shared. */
  sharedLinks: { token: string; conversationId: string; createdAt: Date }[];
  /** The user's Saved prompts, by name. */
  savedPrompts: { name: string; text: string; createdAt: Date }[];
  /** The user's Knowledge files, by name, type and Project; their bytes and passages are never in it. */
  knowledgeFiles: { name: string; mediaType: string; projectId: string }[];
  /** The user's Artifacts, each with every version it has on any Branch (ADR 0016). */
  artifacts: {
    id: string;
    conversationId: string;
    kind: ArtifactKind;
    versions: {
      number: number;
      messageId: string;
      title: string;
      language: string | null;
      content: string;
      createdAt: Date;
    }[];
  }[];
};

/**
 * Reads the user's data in one repeatable-read snapshot and builds the document in memory. An
 * unknown user id gives an empty document, not an error.
 */
export async function exportUserData(deps: BotSdkContext, userId: string): Promise<UserExport> {
  return deps.db.transaction(
    async (tx) => {
      const [settings] = await tx
        .select({
          backgroundModel: userSettings.backgroundModel,
          imageModel: userSettings.imageModel,
          instructions: userSettings.instructions,
          memoryEnabled: userSettings.memoryEnabled,
        })
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
        .where(and(eq(conversation.userId, userId), liveConversation(new Date())))
        .orderBy(asc(conversation.createdAt), asc(conversation.id));

      const messages = (
        await tx
          .select({ message })
          .from(message)
          .innerJoin(conversation, eq(conversation.id, message.conversationId))
          .where(and(eq(conversation.userId, userId), liveConversation(new Date())))
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
        .where(and(eq(conversation.userId, userId), liveConversation(new Date())));

      const images = messageIds.length
        ? await tx
            .select({
              id: generatedImage.id,
              messageId: generatedImage.messageId,
              model: generatedImage.model,
            })
            .from(generatedImage)
            .where(
              and(inArray(generatedImage.messageId, messageIds), eq(generatedImage.userId, userId)),
            )
        : [];
      const promptsByImage = new Map(
        messages.flatMap((row) =>
          row.parts.parts.flatMap((part) =>
            part.type === "generated_image" && part.imageId
              ? [[part.imageId, part.prompt] as const]
              : [],
          ),
        ),
      );
      const memories = await tx
        .select({
          id: memory.id,
          text: memory.text,
          origin: memory.origin,
          conversationId: memory.conversationId,
          replacedById: memory.replacedById,
          invalidAt: memory.invalidAt,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        })
        .from(memory)
        .where(eq(memory.userId, userId))
        .orderBy(asc(memory.createdAt), asc(memory.id));

      const savedPrompts = await tx
        .select({
          name: savedPrompt.name,
          text: savedPrompt.text,
          createdAt: savedPrompt.createdAt,
        })
        .from(savedPrompt)
        .where(eq(savedPrompt.userId, userId))
        .orderBy(asc(savedPrompt.name));

      const artifacts = await tx
        .select({
          id: artifact.id,
          conversationId: artifact.conversationId,
          kind: artifact.kind,
        })
        .from(artifact)
        .innerJoin(conversation, eq(conversation.id, artifact.conversationId))
        .where(and(eq(conversation.userId, userId), liveConversation(new Date())))
        .orderBy(asc(artifact.createdAt), asc(artifact.id));

      const knowledgeFiles = await tx
        .select({
          name: knowledgeFile.name,
          mediaType: knowledgeFile.mediaType,
          projectId: knowledgeFile.projectId,
        })
        .from(knowledgeFile)
        .where(eq(knowledgeFile.userId, userId))
        .orderBy(asc(knowledgeFile.createdAt), asc(knowledgeFile.id));

      const versions = await tx
        .select({
          artifactId: artifactVersion.artifactId,
          number: artifactVersion.number,
          messageId: artifactVersion.messageId,
          title: artifactVersion.title,
          language: artifactVersion.language,
          content: artifactVersion.content,
          createdAt: artifactVersion.createdAt,
        })
        .from(artifactVersion)
        .innerJoin(artifact, eq(artifact.id, artifactVersion.artifactId))
        .innerJoin(conversation, eq(conversation.id, artifact.conversationId))
        .where(and(eq(conversation.userId, userId), liveConversation(new Date())))
        .orderBy(
          asc(artifactVersion.createdAt),
          asc(artifactVersion.messageId),
          asc(artifactVersion.number),
        );

      const attachmentsByMessage = groupBy(attachments, (row) => row.messageId);
      const imagesByMessage = groupBy(images, (row) => row.messageId);
      const messagesByConversation = groupBy(messages, (row) => row.conversationId);
      const versionsByArtifact = groupBy(versions, (row) => row.artifactId);

      return {
        version: 1,
        exportedAt: new Date(),
        settings: {
          backgroundModel: settings?.backgroundModel ?? null,
          imageModel: settings?.imageModel ?? null,
          instructions: settings?.instructions ?? null,
          memoryEnabled: settings?.memoryEnabled ?? true,
        },
        projects,
        conversations: conversations.map((conv) => ({
          id: conv.id,
          title: conv.title,
          model: conv.model,
          reasoningEffort: conv.reasoningEffort,
          projectId: conv.projectId,
          pinnedAt: conv.pinnedAt,
          temporary: conv.temporary,
          archivedAt: conv.archivedAt,
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
            // A Hidden reply can't be rated, so its Rating is left out too (#330).
            rating: row.hiddenAt === null ? row.rating : null,
            hidden: row.hiddenAt !== null,
            createdAt: row.createdAt,
            attachments: (attachmentsByMessage.get(row.id) ?? []).map(
              ({ filename, mediaType }) => ({
                filename,
                mediaType,
              }),
            ),
            generatedImages: (imagesByMessage.get(row.id) ?? []).map((image) => ({
              id: image.id,
              model: image.model,
              prompt: promptsByImage.get(image.id) ?? null,
            })),
          })),
        })),
        memories,
        sharedLinks: links,
        savedPrompts,
        knowledgeFiles,
        artifacts: artifacts.map((row) => ({
          id: row.id,
          conversationId: row.conversationId,
          kind: row.kind,
          versions: (versionsByArtifact.get(row.id) ?? []).map(
            ({ number, messageId, title, language, content, createdAt }) => ({
              number,
              messageId,
              title,
              language,
              content,
              createdAt,
            }),
          ),
        })),
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
