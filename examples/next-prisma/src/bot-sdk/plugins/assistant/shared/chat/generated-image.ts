import type { MessagePart } from "@tanstack/ai";

import { type AspectRatio, aspectRatios } from "../../../models/shared/image-models";
import { type GeneratedImagePart, generatedImageErrorReasons } from "../message-parts";

/**
 * The `generate_image` tool's contract (spec #278), shared by the server tool, the parts boundary
 * and the web app. No server code: safe to import into the browser.
 */

export const generateImageToolName = "generate_image";

/** Images one Run may generate; a call past it fails with `limit_reached`. */
export const maxImagesPerRun = 4;

/** Most images one edit may start from, whatever the Image Model accepts. */
export const maxEditImages = 4;

/** How many images an edit may name on a Model that takes `maxInputImages` input images. */
export const editLimitOf = (maxInputImages: number) => Math.min(maxInputImages, maxEditImages);

/** What the Model reads when an `editImageIds` id isn't an image on its Branch that the user owns. */
export const imageUnavailableError = "That image isn't available to edit on this Branch";

export type GeneratedImageErrorReason = NonNullable<GeneratedImagePart["errorReason"]>;

/** What a user reads for each failed image, under its reply part. */
export const generatedImageErrorLabels: Record<GeneratedImageErrorReason, string> = {
  refused: "Refused by the Provider's safety filter",
  quota_exceeded: "Over today's allowance",
  limit_reached: "Image limit for this reply reached",
  too_many_images: "Too many images to edit",
  failed: "Couldn't generate",
};

/** What the Model reads when the call is past the Run's image limit. */
export const imageLimitError = "image limit reached";

/**
 * The `generate_image` tool result the Model sees, and `useChat` streams. Text only: a made image
 * is its id, prompt and shape. A failed call carries its `reason`.
 */
export type GenerateImageOutput =
  | { imageId: string; prompt: string; aspectRatio: AspectRatio }
  | { error: string; reason: GeneratedImageErrorReason };

/**
 * The image a `useChat` part shows, whether it streamed in or came from `toUIParts`; `null` for any
 * other part. A call that ended without a result was cancelled.
 */
export function generatedImageOf(part: MessagePart): GeneratedImagePart | null {
  if (part.type !== "tool-call" || part.name !== generateImageToolName) return null;
  const input = (part.input ?? {}) as Partial<{
    prompt: unknown;
    aspectRatio: unknown;
    editImageIds: unknown;
  }>;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const aspectRatio = aspectRatios.find((ratio) => ratio === input.aspectRatio) ?? "square";
  const base = { type: "generated_image" as const, toolCallId: part.id, prompt, aspectRatio };
  const output: unknown = part.output;
  if (typeof output === "object" && output !== null) {
    const { imageId, reason } = output as { imageId?: unknown; reason?: unknown };
    if (typeof imageId === "string") {
      const editedFrom = editImageIdsOf(input);
      return { ...base, state: "done", imageId, ...(editedFrom && { editedFrom }) };
    }
    // Only a reason the schema knows is an error; anything else reads as a call still running.
    const errorReason = generatedImageErrorReasons.find((known) => known === reason);
    if (errorReason) return { ...base, state: "error", errorReason };
  }
  return { ...base, state: part.state === "error" ? "cancelled" : "running" };
}

/** The ids an edit named, as its input carries them; `undefined` for a call that edited nothing. */
function editImageIdsOf(input: { editImageIds?: unknown }): string[] | undefined {
  const ids = Array.isArray(input.editImageIds)
    ? input.editImageIds.filter((id): id is string => typeof id === "string")
    : [];
  return ids.length > 0 ? ids : undefined;
}
