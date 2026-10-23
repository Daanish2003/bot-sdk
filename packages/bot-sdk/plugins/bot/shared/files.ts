import { z } from "zod";

/** The most files one Message may carry. */
export const maxFilesPerMessage = 10;

/** The largest file the Bot may send, in bytes. */
export const maxFileBytes = 25 * 1024 * 1024;

/** The image types shown inline, as thumbnails. SVG is left out: it can carry script. */
export const inlineImageTypes: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** One file the Bot sent: its bytes sit in the blob store under `id`. */
export const sentFileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
});

export type SentFile = z.infer<typeof sentFileSchema>;

/**
 * Files the Bot sent from its Computer (spec #761), the Rich control of kind `files`: each was
 * copied to storage at send time, so it downloads from web whatever the Computer does later.
 */
export const filesControlSchema = z.object({
  kind: z.literal("files"),
  files: z.array(sentFileSchema).min(1).max(maxFilesPerMessage),
});

export type FilesControl = z.infer<typeof filesControlSchema>;
