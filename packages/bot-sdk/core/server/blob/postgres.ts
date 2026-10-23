import { eq, inArray } from "drizzle-orm";

import type { Database } from "../db/index";
import { blob } from "../db/schema";
import type { BlobStore } from "./store";

/**
 * The default `BlobStore`: bytes in the `chat.blob` table of the Host's database. The content type
 * isn't kept (the table has no column for it); a file's type lives in its own row, such as `chat.bot_upload`.
 */
export function postgresBlobStore(db: Database): BlobStore {
  return {
    async put(key, bytes) {
      const stored = Buffer.from(bytes);
      await db
        .insert(blob)
        .values({ key, bytes: stored })
        .onConflictDoUpdate({ target: blob.key, set: { bytes: stored } });
    },
    async get(key) {
      const [row] = await db.select({ bytes: blob.bytes }).from(blob).where(eq(blob.key, key));
      return row?.bytes ?? null;
    },
    async delete(keys) {
      if (keys.length === 0) return;
      await db.delete(blob).where(inArray(blob.key, keys));
    },
  };
}
