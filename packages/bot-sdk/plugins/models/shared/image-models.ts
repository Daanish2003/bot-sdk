import type { ProviderId } from "./credentials/services";

/**
 * The curated Image Model list (spec #278): the Models the Generated image tool can run on, for
 * the user's own credentials. Plain data, safe to import into the browser. Separate from the chat
 * catalogue: a chat Model can't make images through this list, and an Image Model needn't chat.
 * Each id is in its TanStack AI adapter package's image model list. `maxInputImages` is how many
 * images the Model edits from; 0 means it only generates, so an edit becomes a fuller prompt.
 */
export type ImageModel = {
  /** `"provider:model"`, as stored in `user_settings.image_model`. */
  id: string;
  provider: ProviderId;
  modelId: string;
  label: string;
  maxInputImages: number;
};

/** An Image Model the user can pick (`models.list`). `onHostCredentials`: a Host pays for it (ADR 0007). */
export type ListedImageModel = ImageModel & { onHostCredentials: boolean };

/** The shapes an Image Model makes an image in. */
export const aspectRatios = ["square", "landscape", "portrait"] as const;
export type AspectRatio = (typeof aspectRatios)[number];

function imageModel(
  provider: ProviderId,
  modelId: string,
  label: string,
  maxInputImages: number,
): ImageModel {
  return { id: `${provider}:${modelId}`, provider, modelId, label, maxInputImages };
}

export const curatedImageModels: ImageModel[] = [
  imageModel("openai", "gpt-image-2", "GPT Image 2", 16),
  imageModel("openai", "gpt-image-1-mini", "GPT Image 1 mini", 16),
  imageModel("openai", "dall-e-3", "DALL·E 3", 0),
  imageModel("gemini", "gemini-3.1-flash-image", "Gemini 3.1 Flash Image", 0),
  imageModel("grok", "grok-imagine-image", "Grok Imagine Image", 3),
  imageModel("byteplus", "seedream-5-0-260128", "Seedream 5.0", 14),
  imageModel("lovable", "openai/gpt-image-2", "GPT Image 2", 16),
  imageModel("lovable", "google/gemini-3.1-flash-image", "Gemini 3.1 Flash Image", 16),
  imageModel("vercel-gateway", "openai/gpt-image-2", "GPT Image 2", 0),
  imageModel("openrouter", "google/gemini-3.1-flash-image", "Gemini 3.1 Flash Image", 0),
  imageModel("openrouter", "openai/gpt-5-image-mini", "GPT-5 Image mini", 0),
];

/** The curated Image Model for a `"provider:model"` id, or `undefined`. */
export function findImageModel(id: string): ImageModel | undefined {
  return curatedImageModels.find((model) => model.id === id);
}
