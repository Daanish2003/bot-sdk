import { and, eq, inArray } from "drizzle-orm";

import { generatedImageBlobKey } from "../blob/store";
import { generatedImage } from "../db/schema";
import type { BotSdkContext } from "../plugin";
import { attachmentKind } from "../../shared/attachments/kinds";
import type { StoredAttachment } from "../../shared/chat/parts";

/** An image an edit reads: its id, media type and bytes (spec #278). */
export type EditSource = { id: string; mediaType: string; bytes: Uint8Array };

/**
 * Resolves the `editImageIds` of a `generate_image` call to the images it may read (spec #278):
 * the image Attachments on the path (`attachments`), and the Generated images the user owns whose
 * reply is on the path (`pathMessageIds`). Any other id makes the whole lookup `undefined`, so the
 * call fails rather than reading an image off another Branch or from another user.
 */
export function editSourcesOf(
  deps: Pick<BotSdkContext, "db" | "blobStore">,
  {
    userId,
    pathMessageIds,
    attachments,
  }: { userId: string; pathMessageIds: string[]; attachments: StoredAttachment[] },
): (ids: string[]) => Promise<EditSource[] | undefined> {
  const pathImages = new Map(
    attachments
      .filter((file) => attachmentKind(file.mediaType, file.filename) === "image")
      .map((file) => [file.id, file]),
  );
  return async (ids) => {
    const notAttachments = ids.filter((id) => !pathImages.has(id));
    const rows =
      notAttachments.length === 0 || pathMessageIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(generatedImage)
            .where(
              and(
                eq(generatedImage.userId, userId),
                inArray(generatedImage.id, notAttachments),
                inArray(generatedImage.messageId, pathMessageIds),
              ),
            );
    const sources: EditSource[] = [];
    for (const id of ids) {
      const file = pathImages.get(id);
      if (file) {
        sources.push({ id, mediaType: file.mediaType, bytes: file.bytes });
        continue;
      }
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return undefined;
      const bytes = await deps.blobStore.get(generatedImageBlobKey(row.id));
      if (!bytes) return undefined;
      sources.push({ id, mediaType: row.mediaType, bytes });
    }
    return sources;
  };
}
