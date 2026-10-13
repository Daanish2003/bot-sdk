import {
  type AnyImageAdapter,
  generateImage,
  type ImageGenerationResult,
  toolDefinition,
} from "@tanstack/ai";
import { z } from "zod";

import { deleteBlobsBestEffort, generatedImageBlobKey } from "../blob/store";
import { generatedImage } from "../db/schema/generated-image";
import type { AppDeps } from "../deps";
import { ImageRefusedError } from "../deps";
import { uuidv7 } from "../lib/uuidv7";
import type { createPartsBuilder } from "../../shared/chat/parts";
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
import type { ToolBudget } from "./host-tools";
import { toolCallLimitError } from "./host-tools";
import type { ImageRequest } from "./adapters";
import { imageInfo } from "./image-info";
import { type ImageMeter, recordImageUsage, usageReported } from "./host-usage";

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
 * in the reply's `parts`, calling `onChange` when they change. A failure is the call's error state
 * and an `{ error, reason }` result, so the Run continues; `ImageRefusedError` is `refused`. Past
 * `maxImagesPerRun` in one Run, or past the reply's shared tool budget, a call is `limit_reached` and
 * makes no image. `mayRun` is checked before each call, and a call it refuses is `quota_exceeded`
 * (ADR 0007). A call cut off by the run ending (its signal aborts) stays running, and the run
 * closes it as cancelled, with no row.
 *
 * Its usage is recorded in `chat.usage` (ADR 0007) when the Provider reported any, or the image was
 * made; a call stopped on an adapter that doesn't cancel upstream is recorded at its flat price.
 */
export function createGenerateImageTool({
  adapter,
  meter,
  request,
  messageId,
  deps,
  fetch,
  timeoutMs,
  parts,
  onChange,
  budget,
  mayRun,
  edit,
}: {
  adapter: AnyImageAdapter;
  /** Whose usage the image is, and the Host's price for it when the call is on Host credentials. */
  meter: ImageMeter;
  /** The size and provider options of one call, for its aspect ratio (spec #278). */
  request: (aspectRatio: AspectRatio) => ImageRequest;
  /** The assistant Message whose reply this call belongs to; the image's row is owned by it. */
  messageId: string;
  /** The rows and the blob store the finished image is kept in (ADR 0015). */
  deps: Pick<AppDeps, "db" | "blobStore" | "logger">;
  /** The SSRF-guarded `fetch`, for an image the Provider returns as a URL. */
  fetch: AppDeps["fetch"];
  timeoutMs: number;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
  budget: ToolBudget;
  /** Whether a paid call may run now (the Quota, on Host credentials); checked before each call. */
  mayRun: () => Promise<boolean>;
  /**
   * The Image Model's input-image limit, and how a call's `editImageIds` resolve to the images it
   * reads (spec #278). Unset, or a limit of 0, the tool takes no edits.
   */
  edit?: {
    maxInputImages: number;
    sources: (ids: string[]) => Promise<EditSource[] | undefined>;
  };
}) {
  let images = 0;
  const editLimit = edit ? editLimitOf(edit.maxInputImages) : 0;
  return generateImageDefinition(editLimit).server(
    async (
      { prompt, aspectRatio = "square", editImageIds }: CallInput,
      context,
    ): Promise<GenerateImageOutput> => {
      // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
      const toolCallId = context?.toolCallId;
      if (!toolCallId) throw new Error("generate_image was called without a tool call id");
      parts.startGeneratedImage(toolCallId, prompt, aspectRatio);
      onChange();
      const fail = (errorReason: GeneratedImageErrorReason, error: string): GenerateImageOutput => {
        parts.finishGeneratedImage(toolCallId, { errorReason });
        return { error, reason: errorReason };
      };
      // The Provider's answer, once it has given one: its usage is billed even when no image is kept.
      let answer: ImageGenerationResult | undefined;
      // Whether the call reached the Provider: a Stop during it may leave the Provider's request running.
      let inFlight = false;
      let stored = false;
      try {
        // The slot is taken before the Quota is awaited, so parallel calls in one Run can't pass the cap.
        if (images >= maxImagesPerRun) return fail("limit_reached", imageLimitError);
        if (!budget.take()) return fail("limit_reached", toolCallLimitError);
        // The edit's ids are the distinct ones the call named; the Model can't go past the limit.
        const ids = editLimit > 0 ? [...new Set(idsOf(editImageIds))] : [];
        if (ids.length > editLimit)
          return fail("too_many_images", generatedImageErrorLabels.too_many_images);
        images++;
        // An id that isn't an image on this Branch, or the user's, fails the call before any paid call.
        const sources = edit && ids.length > 0 ? await edit.sources(ids) : [];
        if (!sources) return fail("failed", imageUnavailableError);
        if (!(await mayRun())) {
          return fail("quota_exceeded", generatedImageErrorLabels.quota_exceeded);
        }
        const signal = context?.abortSignal;
        inFlight = true;
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
        if (!first) return fail("failed", "The Provider returned no image");
        const bytes = await imageBytes(first, fetch, signal);
        // A run ended while the Provider answered keeps no image (the call is cancelled).
        if (signal?.aborted) throw new Error("The reply was stopped");
        const info = imageInfo(bytes);
        if (!info) return fail("failed", "The Provider returned an image in an unknown format");
        const id = uuidv7();
        // The bytes go first, so a row never points at nothing; a failed insert takes them back.
        const key = generatedImageBlobKey(id);
        await deps.blobStore.put(key, bytes, { contentType: info.mediaType });
        try {
          await deps.db.insert(generatedImage).values({
            id,
            userId: meter.userId,
            messageId,
            mediaType: info.mediaType,
            width: info.width,
            height: info.height,
            size: bytes.byteLength,
            model: meter.model,
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
      } catch (caught) {
        // A call cut off by the run ending stays running; the run closes it as cancelled.
        if (context?.abortSignal?.aborted) throw caught;
        if (caught instanceof ImageRefusedError) return fail("refused", caught.message);
        return fail("failed", caught instanceof Error ? caught.message : String(caught));
      } finally {
        const stopped = context?.abortSignal?.aborted === true;
        // A Stop during the call on an adapter that doesn't cancel upstream is billed at the flat
        // price, estimated: the Provider runs the request on to the end. Otherwise a call bills when
        // its image was kept or the Provider reported usage (a stopped call on a cancelling adapter
        // that already answered with usage bills that usage); a refusal or error with no usage bills nothing.
        const billed =
          (stopped && inFlight && !meter.cancelsUpstream) ||
          (answer !== undefined && (stored || usageReported(answer.usage)));
        if (billed) {
          await recordImageUsage({ db: deps.db }, meter, answer?.usage, stopped).catch(
            (caught: unknown) => console.error(`Recording an image of ${messageId} failed`, caught),
          );
        }
        onChange();
      }
    },
  );
}
