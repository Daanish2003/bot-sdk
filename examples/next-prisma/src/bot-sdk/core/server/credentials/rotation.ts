/** How many scans a rotation makes before it gives up on rows a concurrent write keeps changing. */
const maxRotationPasses = 3;

/** One scan of a key rotation; `raced` counts updates that found the row already changed. */
export type RotationScan<Unreadable> = {
  reencrypted: number;
  raced: number;
  unreadable: Unreadable;
};

/**
 * Repeats a rotation's scan until one races no concurrent write, up to `maxRotationPasses` (ADR
 * 0010). Returns every scan's re-encrypted rows and the last scan's unreadable count: it saw every
 * row, so its count is the whole picture.
 */
export async function rotateInPasses<Unreadable>(
  scan: () => Promise<RotationScan<Unreadable>>,
): Promise<{ reencrypted: number; unreadable: Unreadable }> {
  let reencrypted = 0;
  for (let pass = 1; ; pass += 1) {
    const result = await scan();
    reencrypted += result.reencrypted;
    if (result.raced === 0 || pass === maxRotationPasses) {
      return { reencrypted, unreadable: result.unreadable };
    }
  }
}
