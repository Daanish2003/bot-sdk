import { type SQL, inArray } from "drizzle-orm";

import { message, generatedImage } from "../db/schema";
import { generatedImageBlobKey } from "../blob/store";
import type { BotSdkContext } from "../plugin";

/**
 * The blob keys of the Generated images `where` matches (spec #278). A delete's cascade removes
 * their rows and leaves no record of the keys, so they are read first, inside the delete's
 * transaction, and their bytes deleted from the blob store after its commit (ADR 0015).
 */
export async function generatedImageKeysWhere(
  db: Pick<BotSdkContext["db"], "select">,
  where: SQL | undefined,
): Promise<string[]> {
  const rows = await db.select({ id: generatedImage.id }).from(generatedImage).where(where);
  return rows.map((row) => generatedImageBlobKey(row.id));
}

/** Matches the Generated images of the Messages `where` matches (a condition on `message`). */
export function imagesOfMessages(db: Pick<BotSdkContext["db"], "select">, where: SQL) {
  return inArray(
    generatedImage.messageId,
    db.select({ id: message.id }).from(message).where(where),
  );
}
