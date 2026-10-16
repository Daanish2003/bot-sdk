import { attachment, messageAttachment, blob } from "../db/schema";
import { and, asc, eq, inArray, lt, notExists } from "drizzle-orm";

import { attachmentBlobKey, deleteBlobsBestEffort } from "../blob/store";
import type { AppDeps } from "../deps";
import { uuidv7 } from "../lib/uuidv7";
import type { AttachmentInfo } from "../../shared/attachments/kinds";

/**
 * The attachment store: every read and write of attachments goes through here (ADR 0001).
 * Metadata lives in `attachment`, the bytes in the blob store (ADR 0015), so only
 * `loadAttachmentBytes` ever reads bytes.
 */

type Db = AppDeps["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Deps = Pick<AppDeps, "db">;
/** What uploads and the reaper need: the rows, and the store their bytes go to. */
type WriteDeps = Pick<AppDeps, "db" | "blobStore" | "logger">;

const infoColumns = {
  id: attachment.id,
  filename: attachment.filename,
  mediaType: attachment.mediaType,
  size: attachment.size,
};

/** How long an attachment no Message uses is kept before an upload deletes it. */
const orphanAgeMs = 24 * 60 * 60 * 1000;

/** Stores an uploaded file for `userId`, first deleting orphans older than 24 hours. */
export async function saveAttachment(
  deps: WriteDeps,
  userId: string,
  file: { filename: string; mediaType: string; bytes: Uint8Array },
): Promise<AttachmentInfo> {
  const now = new Date();
  await deleteOrphanAttachments(deps, new Date(now.getTime() - orphanAgeMs));
  const id = uuidv7();
  const key = attachmentBlobKey(id);
  // The bytes go first, so a row never points at nothing; a failed insert takes them back.
  await deps.blobStore.put(key, file.bytes, { contentType: file.mediaType });
  try {
    const [row] = await deps.db
      .insert(attachment)
      .values({
        id,
        userId,
        filename: file.filename,
        mediaType: file.mediaType,
        size: file.bytes.byteLength,
        createdAt: now,
      })
      .returning(infoColumns);
    if (!row) throw new Error("Saving the attachment returned no row");
    return row;
  } catch (error) {
    await deleteBlobsBestEffort(deps, [key]);
    throw error;
  }
}

/**
 * Deletes attachments created before `before` that no Message uses, and their bytes. The rows and
 * the Postgres bytes go in one transaction; the store's own delete runs after its commit.
 * Skips attachments a send has locked (`lockAttachments`), which are about to be linked.
 */
export async function deleteOrphanAttachments(deps: WriteDeps, before: Date) {
  const keys = await deps.db.transaction(async (tx) => {
    const orphans = tx
      .select({ id: attachment.id })
      .from(attachment)
      .where(
        and(
          lt(attachment.createdAt, before),
          notExists(
            tx
              .select({ id: messageAttachment.attachmentId })
              .from(messageAttachment)
              .where(eq(messageAttachment.attachmentId, attachment.id)),
          ),
        ),
      )
      .for("update", { skipLocked: true });
    const removed = await tx
      .delete(attachment)
      .where(inArray(attachment.id, orphans))
      .returning({ id: attachment.id });
    const removedKeys = removed.map((row) => attachmentBlobKey(row.id));
    if (removedKeys.length > 0) await tx.delete(blob).where(inArray(blob.key, removedKeys));
    return removedKeys;
  });
  await deleteBlobsBestEffort(deps, keys);
}

/**
 * Locks the user's attachments against the orphan cleanup for the rest of the send's
 * transaction; `false` when one is gone (deleted, or never theirs).
 */
export async function lockAttachments(tx: Tx, userId: string, ids: string[]) {
  if (ids.length === 0) return true;
  const rows = await tx
    .select({ id: attachment.id })
    .from(attachment)
    .where(and(inArray(attachment.id, ids), eq(attachment.userId, userId)))
    .for("key share");
  return rows.length === ids.length;
}

/** The ones of `ids` that `userId` uploaded, in the order of `ids`. */
export async function findOwnedAttachments(
  deps: Deps,
  userId: string,
  ids: string[],
): Promise<AttachmentInfo[]> {
  if (ids.length === 0) return [];
  const rows = await deps.db
    .select(infoColumns)
    .from(attachment)
    .where(and(inArray(attachment.id, ids), eq(attachment.userId, userId)));
  return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

/** Each Message's attachments, in order; Messages without any are missing from the map. */
export async function attachmentsOfMessages(
  deps: Deps,
  messageIds: string[],
): Promise<Map<string, AttachmentInfo[]>> {
  const byMessage = new Map<string, AttachmentInfo[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await deps.db
    .select({ messageId: messageAttachment.messageId, ...infoColumns })
    .from(messageAttachment)
    .innerJoin(attachment, eq(attachment.id, messageAttachment.attachmentId))
    .where(inArray(messageAttachment.messageId, messageIds))
    .orderBy(asc(messageAttachment.position));
  for (const { messageId, ...info } of rows) {
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), info]);
  }
  return byMessage;
}

/** The bytes of each attachment, by id. */
export async function loadAttachmentBytes(
  deps: Pick<AppDeps, "blobStore">,
  ids: string[],
): Promise<Map<string, Uint8Array>> {
  const loaded = await Promise.all(
    [...new Set(ids)].map(
      async (id) => [id, await deps.blobStore.get(attachmentBlobKey(id))] as const,
    ),
  );
  return new Map(loaded.flatMap(([id, bytes]) => (bytes ? [[id, bytes] as const] : [])));
}

/** Links attachments to a new Message, in order. */
export async function linkAttachments(tx: Tx, messageId: string, attachmentIds: string[]) {
  if (attachmentIds.length === 0) return;
  await tx
    .insert(messageAttachment)
    .values(attachmentIds.map((attachmentId, position) => ({ messageId, attachmentId, position })));
}
