import { attachment, messageAttachment, blob } from "../../core/server/db/schema";
import { getTestDb } from "./test-database";

import { attachmentBlobKey } from "../../core/server/blob/store";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import type { TestUser } from "./users";

/**
 * Inserts an attachment for `user` straight into the test database, skipping upload checks.
 * `size` defaults to the byte count; set it to test the size limits without storing megabytes.
 */
export async function insertAttachment(
  user: TestUser,
  {
    filename = "notes.txt",
    mediaType = "text/plain",
    contents = "Some notes",
    size,
    createdAt = new Date(),
  }: {
    filename?: string;
    mediaType?: string;
    contents?: string | Uint8Array;
    size?: number;
    createdAt?: Date;
  } = {},
) {
  const db = getTestDb();
  const bytes = Buffer.from(contents);
  const id = uuidv7();
  await db.insert(attachment).values({
    id,
    userId: user.id,
    filename,
    mediaType,
    size: size ?? bytes.byteLength,
    createdAt,
  });
  await db.insert(blob).values({ key: attachmentBlobKey(id), bytes });
  return { id, filename, mediaType, size: size ?? bytes.byteLength };
}

/** Links attachments to a Message straight in the test database, in order. */
export async function linkTestAttachments(messageId: string, attachmentIds: string[]) {
  await getTestDb()
    .insert(messageAttachment)
    .values(attachmentIds.map((attachmentId, position) => ({ messageId, attachmentId, position })));
}
