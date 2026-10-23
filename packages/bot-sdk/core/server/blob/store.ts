/**
 * Where file bytes live (ADR 0015). The store holds whole byte arrays under keys the SDK makes up,
 * such as `bot-file/<id>`; names, types, sizes and owners stay in Postgres. A Host picks the store
 * with `createBotSdk({ blobStore })`, and the default is `postgresBlobStore()`.
 */
export type BlobStore = {
  /** Stores `bytes` under `key`, replacing anything already there. */
  put: (key: string, bytes: Uint8Array, options: { contentType: string }) => Promise<void>;
  /** The bytes under `key`, or `null` when there are none. */
  get: (key: string) => Promise<Uint8Array | null>;
  /** Removes each key's bytes; keys with no bytes are skipped. */
  delete: (keys: string[]) => Promise<void>;
};

/**
 * Deletes `keys` from `blobStore` after their rows are gone. A failure is logged and never thrown:
 * a stray object costs storage but no data, and nothing sweeps it (ADR 0015).
 */
export async function deleteBlobsBestEffort(
  { blobStore, logger }: { blobStore: BlobStore; logger: Pick<Console, "error"> },
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await blobStore.delete(keys);
  } catch (error) {
    logger.error("Deleting blobs failed; their bytes may be stored", { keys, error });
  }
}
