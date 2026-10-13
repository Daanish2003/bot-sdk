import type { MessagePart } from "@tanstack/ai";

import type { GeneratedImagePart } from "../message-parts";

/**
 * The `generate_image` tool's contract (spec #278), shared by the server tool, the parts boundary
 * and the web app. No server code: safe to import into the browser.
 */

export const generateImageToolName = "generate_image";

export const aspectRatios = ["square", "landscape", "portrait"] as const;
export type AspectRatio = (typeof aspectRatios)[number];

/** Images one Run may generate; a call past it fails with `limit_reached`. */
export const maxImagesPerRun = 4;

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
  const input = (part.input ?? {}) as Partial<{ prompt: unknown; aspectRatio: unknown }>;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const aspectRatio = aspectRatios.find((ratio) => ratio === input.aspectRatio) ?? "square";
  const base = { type: "generated_image", toolCallId: part.id, prompt, aspectRatio } as const;
  const output = part.output as Partial<GenerateImageOutput> | null | undefined;
  if (output && typeof (output as { imageId?: unknown }).imageId === "string") {
    return { ...base, state: "done", imageId: (output as { imageId: string }).imageId };
  }
  if (output && typeof (output as { reason?: unknown }).reason === "string") {
    const reason = (output as { reason: GeneratedImageErrorReason }).reason;
    return { ...base, state: "error", errorReason: reason };
  }
  return { ...base, state: part.state === "error" ? "cancelled" : "running" };
}
