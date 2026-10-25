import { generateImage, type ImageGenerationResult, toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import type { BotSdkContext } from "../../../../core/server/plugin";
import {
  ComputerOperationError,
  ComputerUnavailableError,
} from "../../../computer/server/internal";
import { ImageRefusedError } from "../../../models/server/internal";
import type { ResolvedImageModel } from "../../../models/server/internal";
import { aspectRatios } from "../../../models/shared/image-models";
import { WorkflowYieldedError } from "../../../runner/server/internal";
import { computerOf, computerOperationError, computerUnavailableError } from "../agent-loop";
import { sniffImageType, resolvePath } from "../conversation";
import type { LoopKit } from "../agent-loop";

export const generateImageToolName = "generate_image";

/** Images one Turn may make; the next call gets `imageLimitError`. */
export const maxImagesPerTurn = 4;

/** Most Computer images one call may edit, whatever the Image Model accepts. */
export const maxEditImages = 4;

/** How long one image may take. */
export const imageTimeoutMs = 120_000;

/** What `generate_image` returns when the user has no usable Image Model. */
export const noImageModelError = "No image Model: ask the user to pick one in Settings";

export const imageLimitError = "image limit reached";

const quotaError = "Over this window's Quota, so the image wasn't made";

/** What the tool returns: the path of the image on the Computer, or why there is none. */
export type GenerateImageOutput = { path: string; aspectRatio: string } | { error: string };

const definition = toolDefinition({
  name: generateImageToolName,
  description:
    "Make an image from a text prompt, saved on your computer under images/. Returns its path; " +
    "send it to the user with send_to_user({ files: [path] }). Use it when the user asks for a " +
    `picture, drawing or logo. At most ${maxImagesPerTurn} images per turn. To change an image, ` +
    `pass its path in editPaths (up to ${maxEditImages}; only on Image Models that can edit); each ` +
    "call makes a new file and leaves the source as it was.",
  inputSchema: z.object({
    prompt: z.string().min(1).meta({ description: "What the image should show" }),
    aspectRatio: z
      .enum(aspectRatios)
      .optional()
      .meta({ description: "The shape of the image; square when left out" }),
    editPaths: z
      .array(z.string())
      .optional()
      .meta({ description: "Paths of images on your computer to edit" }),
  }),
});

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The image types an Image Model edits; a GIF is an image it can't. */
const editableTypes = new Set(Object.keys(extensions));

/** The bytes of an image a Provider made: decoded, or downloaded at once since Providers' URLs expire. */
async function bytesOf(
  image: { b64Json?: string; url?: string },
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (image.b64Json) return Buffer.from(image.b64Json, "base64");
  const response = await fetch(image.url!, signal ? { signal } : {});
  if (!response.ok)
    throw new Error(`The Provider's image could not be downloaded (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The `generate_image` tool of a Turn (spec #801), a deferred tool. It follows `web_search`: the
 * Quota is checked before the call, the image is made and written to the Computer outside any
 * transaction (a replay returns the recorded path without drawing again), and the cost is recorded
 * in the write Checkpoint, so it is billed once. A failure is the tool's result, so the Turn goes on.
 */
export function generateImageTool(
  deps: BotSdkContext,
  turn: { userId: string; botId: string },
  liveRequest: LoopKit["liveRequest"],
) {
  const models = () => deps.models;
  const resolve = () => models().resolveUserImageModel(turn.userId);
  // Reserved before anything is awaited, so parallel calls can't pass the cap.
  let images = 0;
  return definition.server(async ({ prompt, aspectRatio = "square", editPaths }, context) => {
    const number = ++images;
    const signal = context?.abortSignal;
    // What the live call ran on and how far it got; an attempt that resumes at the write has none.
    let image: ResolvedImageModel | null | undefined;
    let reached = false;
    let answer: ImageGenerationResult | undefined;
    let usageRecorded = () => {};
    const request = liveRequest(
      generateImageToolName,
      context?.toolCallId,
      async (): Promise<GenerateImageOutput> => {
        if (number > maxImagesPerTurn) return { error: imageLimitError };
        image = await resolve();
        if (!image) return { error: noImageModelError };
        let adapter: ReturnType<ReturnType<typeof models>["imageAdapterFor"]>;
        try {
          adapter = models().imageAdapterFor(image.id, image.credentials);
        } catch {
          adapter = undefined;
        }
        if (!adapter) return { error: noImageModelError };
        const editLimit = Math.min(image.maxInputImages, maxEditImages);
        const paths = [...new Set(editPaths ?? [])];
        if (paths.length > 0 && editLimit === 0) {
          return {
            error:
              "This Image Model can't edit images. Describe the whole picture in the prompt instead.",
          };
        }
        if (paths.length > editLimit) {
          return { error: `You can edit at most ${editLimit} images in one call.` };
        }
        // Before the Computer wakes or any file is read.
        if (!(await image.meter.mayRun()).ok) return { error: quotaError };
        const computer = computerOf(deps, turn.userId);
        try {
          const sources: {
            type: "image";
            source: { type: "data"; value: string; mimeType: string };
          }[] = [];
          for (const path of paths) {
            const bytes = await computer.readFile(resolvePath(turn.botId, path), { signal });
            const mimeType = bytes && sniffImageType(bytes);
            if (!bytes || !mimeType) return { error: `${path} is not an image on your computer.` };
            if (!editableTypes.has(mimeType)) {
              return {
                error: `${path} is a GIF, which can't be edited; use a PNG, JPEG or WebP image.`,
              };
            }
            sources.push({
              type: "image",
              source: { type: "data", value: Buffer.from(bytes).toString("base64"), mimeType },
            });
          }
          reached = true;
          answer = await generateImage({
            adapter,
            threadId: turn.botId,
            prompt: sources.length > 0 ? [{ type: "text", content: prompt }, ...sources] : prompt,
            ...models().imageRequestFor(image.id, aspectRatio, image.hostModel),
            timeout: imageTimeoutMs,
            ...(signal && { abortSignal: signal }),
          });
          const first = answer.images[0];
          if (!first) return { error: "The Provider returned no image" };
          const bytes = await bytesOf(first, deps.fetch, signal);
          // A Turn stopped while the Provider answered leaves the call unanswered.
          signal?.throwIfAborted();
          const type = sniffImageType(bytes);
          if (!type || !editableTypes.has(type))
            return { error: "The Provider returned an image in an unknown format" };
          const path = `images/${uuidv7()}.${extensions[type]}`;
          await computer.writeFile(resolvePath(turn.botId, path), bytes, { signal });
          return { path, aspectRatio };
        } catch (caught) {
          if (signal?.aborted) throw caught;
          if (caught instanceof ComputerUnavailableError)
            return { error: computerUnavailableError };
          if (caught instanceof ComputerOperationError) {
            return { error: computerOperationError(caught.message) };
          }
          if (caught instanceof ImageRefusedError) return { error: caught.message };
          if (!reached) throw caught;
          return { error: caught instanceof Error ? caught.message : String(caught) };
        }
      },
      async (tx, result) => {
        const stored = typeof result !== "string" && "path" in result;
        // Nothing reached the Provider: nothing to bill.
        if (!reached && !stored) return;
        image ??= await resolve();
        if (!image) return;
        usageRecorded = await image.meter.recordIn(tx, {
          reached: true,
          answered: answer !== undefined || stored,
          usage: answer?.usage,
          stored,
          stopped: false,
        });
      },
    );
    try {
      const output = await request;
      // Only once the record has committed, and never on a replay.
      usageRecorded();
      return output;
    } catch (caught) {
      // A yield is thrown once the record's Checkpoint has committed: its next attempt replays the
      // record, so it fires now or never.
      if (caught instanceof WorkflowYieldedError) usageRecorded();
      throw caught;
    }
  });
}
