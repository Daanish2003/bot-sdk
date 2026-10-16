import {
  type AnyImageAdapter,
  generateImage,
  type ImageGenerationResult,
  toolDefinition,
} from "@tanstack/ai";
import { z } from "zod";

import { deleteBlobsBestEffort, generatedImageBlobKey } from "../blob/store";
import { generatedImage } from "../db/schema";
import type { AppDeps } from "../deps";
import { ImageRefusedError } from "../deps";
import { uuidv7 } from "../lib/uuidv7";
import {
  type AspectRatio,
  aspectRatios,
  type GenerateImageOutput,
  type GeneratedImageErrorReason,
  generatedImageErrorLabels,
  editLimitOf,
  generateImageToolName,
  imageLimitError,
  imageUnavailableError,
  maxImagesPerRun,
} from "../../shared/chat/generated-image";
import type { EditSource } from "./edit-sources";
import type { ImageRequest } from "./adapters";
import { imageInfo } from "./image-info";
import type { ImageMeter } from "./meter";
import { type RunToolState, toolCallLimitError, trackedTool } from "./tracked-tool";

/**
 * The bytes of one image a Provider made (spec #278): a `b64Json` result is decoded; a `url` result
 * is downloaded at once, since Providers' URLs expire. A run's signal cuts the download short.
 */
export async function imageBytes(
  image: { b64Json?: string; url?: string },
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (image.b64Json) return Buffer.from(image.b64Json, "base64");
  return new Uint8Array(await (await fetch(image.url!, signal ? { signal } : {})).arrayBuffer());
}

/**
 * The tool's definition for an Image Model that takes `editLimit` input images (spec #278). At 0 it
 * has no `editImageIds`, and its description says edits aren't supported, so the Model regenerates
 * from a fuller prompt.
 */
function generateImageDefinition(editLimit: number) {
  const editable = editLimit > 0;
  return toolDefinition({
    name: generateImageToolName,
    description:
      "Make an image from a text prompt. Use it whenever the user asks for a picture, drawing, logo or " +
      `other image. Write the prompt from what the user asked for; choose aspectRatio when they name a shape. At most ${maxImagesPerRun} images per reply. ` +
      (editable
        ? `To change earlier images, pass their ids in editImageIds (up to ${editLimit}): an imageId you were given, or the id of an image the user attached. Each call makes a new image and leaves the source as it was.`
        : "Edits of earlier images aren't supported by this image model, so to change one, write a prompt that describes the whole picture."),
    inputSchema: z.object({
      prompt: z.string().min(1).meta({ description: "What the image should show" }),
      aspectRatio: z
        .enum(aspectRatios)
        .optional()
        .meta({ description: "The shape of the image; square when left out" }),
      ...(editable
        ? {
            editImageIds: z.array(z.string()).optional().meta({
              description: "Ids of the images to edit, from earlier in this conversation",
            }),
          }
        : {}),
    }),
  });
}

/** A call's arguments as the handler reads them; `editImageIds` only when the tool takes edits. */
type CallInput = { prompt: string; aspectRatio?: AspectRatio; editImageIds?: unknown };

/** The ids a call named, as strings; the schema has already checked them, so anything else is none. */
const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** An image of an edit's input, as a part of the `generateImage` prompt (spec #278). */
const editImagePart = (source: EditSource) => ({
  type: "image" as const,
  source: {
    type: "data" as const,
    value: Buffer.from(
      source.bytes.buffer,
      source.bytes.byteOffset,
      source.bytes.byteLength,
    ).toString("base64"),
    mimeType: source.mediaType,
  },
});

/**
 * The `generate_image` server tool for one Run (spec #278). Each call makes one image through
 * `adapter`, copies it into `generated_image` (its row is what `imageId` names) and records the call
 * in the reply's `parts` (`trackedTool`). A failure is the call's error state and an
 * `{ error, reason }` result, so the Run continues; `ImageRefusedError` is `refused`. Past
 * `maxImagesPerRun` in one Run (which takes no call from the budget), or past the reply's shared
 * tool budget, a call is `limit_reached` and makes no image. `meter` checks the Quota once the
 * call's edit sources are found, and a call it refuses is `quota_exceeded` and keeps its image slot
 * (ADR 0007). A call cut off by the run ending keeps no row.
 *
 * Each call that gets past those two limits ends by telling `meter` how far it got, which records
 * its usage in `chat.usage` when it is billed (ADR 0007).
 */
export function createGenerateImageTool({
  adapter,
  meter,
  userId,
  model,
  request,
  messageId,
  deps,
  fetch,
  timeoutMs,
  edit,
  ...run
}: RunToolState & {
  adapter: AnyImageAdapter;
  /** Checks the Quota before each call and records its usage (ADR 0007). */
  meter: ImageMeter;
  /** The user the image is made for. */
  userId: string;
  /** The Image Model's `"provider:model"` id, which the image's row records. */
  model: string;
  /** The size and provider options of one call, for its aspect ratio (spec #278). */
  request: (aspectRatio: AspectRatio) => ImageRequest;
  /** The assistant Message whose reply this call belongs to; the image's row is owned by it. */
  messageId: string;
  /** The rows and the blob store the finished image is kept in (ADR 0015). */
  deps: Pick<AppDeps, "db" | "blobStore" | "logger">;
  /** The SSRF-guarded `fetch`, for an image the Provider returns as a URL. */
  fetch: AppDeps["fetch"];
  timeoutMs: number;
  /**
   * The Image Model's input-image limit, and how a call's `editImageIds` resolve to the images it
   * reads (spec #278). Unset, or a limit of 0, the tool takes no edits.
   */
  edit?: {
    maxInputImages: number;
    sources: (ids: string[]) => Promise<EditSource[] | undefined>;
  };
}) {
  const { parts } = run;
  let images = 0;
  const editLimit = edit ? editLimitOf(edit.maxInputImages) : 0;
  const fail = (
    toolCallId: string,
    errorReason: GeneratedImageErrorReason,
    error: string,
  ): GenerateImageOutput => {
    parts.finishGeneratedImage(toolCallId, { errorReason });
    return { error, reason: errorReason };
  };
  return generateImageDefinition(editLimit).server(
    trackedTool(
      generateImageToolName,
      run,
      {
        // Checked before anything is awaited, so parallel calls in one Run can't pass the cap.
        capReached: () => images >= maxImagesPerRun,
        part: {
          start: (toolCallId, { prompt, aspectRatio = "square" }: CallInput) =>
            parts.startGeneratedImage(toolCallId, prompt, aspectRatio),
          refused: (toolCallId, why) =>
            fail(toolCallId, "limit_reached", why === "cap" ? imageLimitError : toolCallLimitError),
          failed: (toolCallId, caught) =>
            caught instanceof ImageRefusedError
              ? fail(toolCallId, "refused", caught.message)
              : fail(
                  toolCallId,
                  "failed",
                  caught instanceof Error ? caught.message : String(caught),
                ),
        },
      },
      async (
        { prompt, aspectRatio = "square", editImageIds },
        { toolCallId, signal },
      ): Promise<GenerateImageOutput> => {
        // The Provider's answer, once it has given one: its usage is billed even when no image is kept.
        let answer: ImageGenerationResult | undefined;
        // Whether the call reached the Provider: a Stop during it may leave the Provider's request running.
        let reached = false;
        let stored = false;
        try {
          // The edit's ids are the distinct ones the call named; the Model can't go past the limit.
          const ids = editLimit > 0 ? [...new Set(idsOf(editImageIds))] : [];
          if (ids.length > editLimit) {
            return fail(toolCallId, "too_many_images", generatedImageErrorLabels.too_many_images);
          }
          images++;
          // An id that isn't an image on this Branch, or the user's, fails the call before any paid call.
          const sources = edit && ids.length > 0 ? await edit.sources(ids) : [];
          if (!sources) return fail(toolCallId, "failed", imageUnavailableError);
          if (!(await meter.mayRun()).ok) {
            return fail(toolCallId, "quota_exceeded", generatedImageErrorLabels.quota_exceeded);
          }
          reached = true;
          answer = await generateImage({
            adapter,
            // An edit's prompt is its text, then each source image, in the order the call named them.
            prompt:
              sources.length > 0
                ? [{ type: "text" as const, content: prompt }, ...sources.map(editImagePart)]
                : prompt,
            ...request(aspectRatio),
            timeout: timeoutMs,
            ...(signal && { abortSignal: signal }),
          });
          const first = answer.images[0];
          if (!first) return fail(toolCallId, "failed", "The Provider returned no image");
          const bytes = await imageBytes(first, fetch, signal);
          // A run ended while the Provider answered keeps no image (the call is cancelled).
          if (signal?.aborted) throw new Error("The reply was stopped");
          const info = imageInfo(bytes);
          if (!info) {
            return fail(
              toolCallId,
              "failed",
              "The Provider returned an image in an unknown format",
            );
          }
          const id = uuidv7();
          // The bytes go first, so a row never points at nothing; a failed insert takes them back.
          const key = generatedImageBlobKey(id);
          await deps.blobStore.put(key, bytes, { contentType: info.mediaType });
          try {
            await deps.db.insert(generatedImage).values({
              id,
              userId,
              messageId,
              mediaType: info.mediaType,
              width: info.width,
              height: info.height,
              size: bytes.byteLength,
              model,
              createdAt: new Date(),
            });
          } catch (error) {
            await deleteBlobsBestEffort(deps, [key]);
            throw error;
          }
          stored = true;
          parts.finishGeneratedImage(toolCallId, {
            imageId: id,
            ...(ids.length > 0 && { editedFrom: ids }),
          });
          return { imageId: id, prompt, aspectRatio: aspectRatio as AspectRatio };
        } finally {
          await meter.record({
            reached,
            answered: answer !== undefined,
            usage: answer?.usage,
            stored,
            stopped: signal?.aborted === true,
          });
        }
      },
    ),
  );
}
