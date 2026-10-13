import { type AnyImageAdapter, generateImage, toolDefinition } from "@tanstack/ai";
import { z } from "zod";

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
  generateImageToolName,
  imageLimitError,
  maxImagesPerRun,
} from "../../shared/chat/generated-image";
import type { ToolBudget } from "./host-tools";
import { toolCallLimitError } from "./host-tools";
import { imageInfo } from "./image-info";

const generateImageDefinition = toolDefinition({
  name: generateImageToolName,
  description:
    "Make an image from a text prompt. Use it whenever the user asks for a picture, drawing, logo or " +
    `other image. Write the prompt from what the user asked for; choose aspectRatio when they name a shape. At most ${maxImagesPerRun} images per reply.`,
  inputSchema: z.object({
    prompt: z.string().min(1).meta({ description: "What the image should show" }),
    aspectRatio: z
      .enum(aspectRatios)
      .optional()
      .meta({ description: "The shape of the image; square when left out" }),
  }),
});

/**
 * The `generate_image` server tool for one Run (spec #278). Each call makes one image through
 * `adapter`, copies it into `generated_image` (its row is what `imageId` names) and records the call
 * in the reply's `parts`, calling `onChange` when they change. A failure is the call's error state
 * and an `{ error, reason }` result, so the Run continues; `ImageRefusedError` is `refused`. Past
 * `maxImagesPerRun` in one Run, or past the reply's shared tool budget, a call is `limit_reached` and
 * makes no image. A call cut off by the run ending (its signal aborts) stays running, and the run
 * closes it as cancelled, with no row.
 */
export function createGenerateImageTool({
  adapter,
  model,
  size,
  userId,
  messageId,
  db,
  fetch,
  timeoutMs,
  parts,
  onChange,
  budget,
}: {
  adapter: AnyImageAdapter;
  /** The Image Model's `"provider:model"` id, which the image's row records. */
  model: string;
  /** The size the Image Model is pinned to, when it is a Host Image Model. */
  size?: string;
  userId: string;
  /** The assistant Message whose reply this call belongs to; the image's row is owned by it. */
  messageId: string;
  db: AppDeps["db"];
  /** The SSRF-guarded `fetch`, for an image the Provider returns as a URL. */
  fetch: AppDeps["fetch"];
  timeoutMs: number;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
  budget: ToolBudget;
}) {
  let images = 0;
  return generateImageDefinition.server(
    async ({ prompt, aspectRatio = "square" }, context): Promise<GenerateImageOutput> => {
      // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
      const toolCallId = context?.toolCallId;
      if (!toolCallId) throw new Error("generate_image was called without a tool call id");
      parts.startGeneratedImage(toolCallId, prompt, aspectRatio);
      onChange();
      const fail = (errorReason: GeneratedImageErrorReason, error: string): GenerateImageOutput => {
        parts.finishGeneratedImage(toolCallId, { errorReason });
        return { error, reason: errorReason };
      };
      try {
        if (images >= maxImagesPerRun) return fail("limit_reached", imageLimitError);
        if (!budget.take()) return fail("limit_reached", toolCallLimitError);
        images++;
        const signal = context?.abortSignal;
        const result = await generateImage({
          adapter,
          prompt,
          ...(size !== undefined && { size }),
          timeout: timeoutMs,
          ...(signal && { abortSignal: signal }),
        });
        const first = result.images[0];
        if (!first) return fail("failed", "The Provider returned no image");
        const bytes = first.b64Json
          ? Buffer.from(first.b64Json, "base64")
          : new Uint8Array(await (await fetch(first.url!, signal ? { signal } : {})).arrayBuffer());
        // A run ended while the Provider answered keeps no image (the call is cancelled).
        if (signal?.aborted) throw new Error("The reply was stopped");
        const info = imageInfo(bytes);
        if (!info) return fail("failed", "The Provider returned an image in an unknown format");
        const id = uuidv7();
        await db.insert(generatedImage).values({
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
        parts.finishGeneratedImage(toolCallId, { imageId: id });
        return { imageId: id, prompt, aspectRatio: aspectRatio as AspectRatio };
      } catch (caught) {
        // A call cut off by the run ending stays running; the run closes it as cancelled.
        if (context?.abortSignal?.aborted) throw caught;
        if (caught instanceof ImageRefusedError) return fail("refused", caught.message);
        return fail("failed", caught instanceof Error ? caught.message : String(caught));
      } finally {
        onChange();
      }
    },
  );
}
