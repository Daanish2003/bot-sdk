import type { ContentPart, ModelMessage } from "@tanstack/ai";

import type { BlobStore } from "../../storage";
import { botFileRef, sentFileBlobKey } from "./files";
import { screenshotBlobKey } from "./screenshots";

/** What an older screenshot becomes in the model's input. */
export const removedScreenshot = "[older screenshot removed]";

/** How many of the newest screenshots stay in the model's input. */
export const keptScreenshots = 3;

/** What a screenshot whose bytes are gone from the blob store becomes in the model's input. */
export const missingScreenshot = "[screenshot missing]";

/** Whether a content part is a screenshot the computer tool returned. */
const isImage = (part: ContentPart) => part.type === "image";

/**
 * The input of a model call with only the newest `keptScreenshots` screenshots in it: each older
 * one becomes `removedScreenshot`. The messages themselves are not changed.
 */
export function pruneScreenshots(messages: readonly ModelMessage[]): ModelMessage[] {
  let kept = 0;
  const pruned = [...messages];
  for (let i = pruned.length - 1; i >= 0; i -= 1) {
    const entry = pruned[i]!;
    if (entry.role !== "tool" || !Array.isArray(entry.content)) continue;
    const content = entry.content as ContentPart[];
    if (!content.some(isImage)) continue;
    kept += 1;
    if (kept <= keptScreenshots) continue;
    pruned[i] = {
      ...entry,
      content: content.map((part) =>
        isImage(part) ? { type: "text" as const, content: removedScreenshot } : part,
      ),
    };
  }
  return pruned;
}

/** How a stored screenshot's image part names it: `screenshot:<id>`, never a real URL. */
const screenshotRef = "screenshot:";

/** The image part of stored screenshot `screenshotId`: its ref, resolved only when the Model is called. */
export const screenshotPart = (screenshotId: string): ContentPart => ({
  type: "image",
  source: { type: "url", value: `${screenshotRef}${screenshotId}`, mimeType: "image/png" },
});

/** What a user's image whose bytes are gone from the blob store becomes in the model's input. */
export const missingUserImage = "[the user's image is no longer stored]";

/** What a user's image the model call leaves out becomes: the line beside it names the file. */
export const userImageLeftOut = "[the user's image, left out: open the file named above]";

/** The most bytes of the user's images one model call sends; history is resent on every call. */
export const maxHistoryImageBytes = 20 * 1024 * 1024;

/**
 * A model call's input with each image ref resolved to its bytes from the blob store: a Helper's
 * screenshot (run after `pruneScreenshots`, so only the kept ones are read), and an image the user
 * sent with a Message (spec #801). The user's images go only to a Model that `seesImages`, newest
 * first up to `maxHistoryImageBytes`; the rest become `userImageLeftOut`, unread. One whose bytes
 * are gone becomes `missingScreenshot` or `missingUserImage`. The messages themselves are not
 * changed.
 */
export async function resolveImageRefs(
  blobStore: Pick<BlobStore, "get">,
  messages: readonly ModelMessage[],
  { seesImages }: { seesImages: boolean },
): Promise<ModelMessage[]> {
  // The user's images, newest first, each read while the budget lasts.
  const userImages = new Map<string, Uint8Array | null | "left out">();
  let budget = seesImages ? maxHistoryImageBytes : 0;
  for (const entry of [...messages].reverse()) {
    if (!Array.isArray(entry.content)) continue;
    for (const part of [...(entry.content as ContentPart[])].reverse()) {
      if (!isRef(part) || !part.source.value.startsWith(botFileRef)) continue;
      const ref = part.source.value;
      if (userImages.has(ref)) continue;
      const bytes =
        budget > 0 ? await blobStore.get(sentFileBlobKey(ref.slice(botFileRef.length))) : null;
      if (budget <= 0 || (bytes && bytes.length > budget)) {
        userImages.set(ref, "left out");
        budget = 0;
        continue;
      }
      userImages.set(ref, bytes);
      if (bytes) budget -= bytes.length;
    }
  }
  return Promise.all(
    messages.map(async (entry) => {
      if (!Array.isArray(entry.content)) return entry;
      const content = entry.content as ContentPart[];
      if (!content.some(isRef)) return entry;
      return {
        ...entry,
        content: await Promise.all(
          content.map(async (part): Promise<ContentPart> => {
            if (!isRef(part)) return part;
            const ref = part.source.value;
            const screenshot = ref.startsWith(screenshotRef);
            const bytes = screenshot
              ? await blobStore.get(screenshotBlobKey(ref.slice(screenshotRef.length)))
              : userImages.get(ref);
            if (bytes === "left out") return { type: "text", content: userImageLeftOut };
            if (!bytes) {
              return { type: "text", content: screenshot ? missingScreenshot : missingUserImage };
            }
            const value = Buffer.from(bytes).toString("base64");
            const mimeType = screenshot ? "image/png" : (part.source.mimeType ?? "image/png");
            return { type: "image", source: { type: "data", value, mimeType } };
          }),
        ),
      };
    }),
  );
}

/** Whether a content part is a stored screenshot's ref or a user's image's. */
function isRef(part: ContentPart): part is ContentPart & {
  type: "image";
  source: { type: "url"; value: string; mimeType?: string };
} {
  return (
    part.type === "image" &&
    part.source.type === "url" &&
    (part.source.value.startsWith(screenshotRef) || part.source.value.startsWith(botFileRef))
  );
}
