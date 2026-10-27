import type { AspectRatio } from "@botsdk/client/models/image-models";
import { isKnownModel, parseModelId } from "@botsdk/client/models/models";
import type { AnyImageAdapter, AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { chatgptPlanFetch } from "./chatgpt-plan";
import type { Credentials, ModelProviders } from "./types";

/**
 * The production `deps.adapterFor` and `deps.imageAdapterFor` (spec #875), over the Providers the
 * Host passed in `models.providers`. A Model whose Provider the Host didn't pass, or that the Provider
 * has no adapter for, throws, so it fails loudly rather than run on nothing. On a linked ChatGPT
 * plan (`options.linked`), the Provider's adapter sends through the plan's `fetch` (ADR 0023), and
 * a Provider that doesn't declare `honoursFetch` is refused. Every text adapter gets the run's
 * abort signal on its requests (`withRunSignal`).
 */
export function adaptersOf(providers: ModelProviders) {
  return {
    adapterFor(
      model: string,
      credentials: Credentials,
      options?: { linked?: boolean },
    ): AnyTextAdapter {
      const parsed = parseModelId(model);
      if (!parsed || !isKnownModel(model)) {
        throw new Error(`"${model}" is not an available Model`);
      }
      const provider = providers[parsed.provider];
      if (!provider?.text) {
        throw new Error(`No adapter is available for the ${parsed.provider} Provider`);
      }
      if (options?.linked && !provider.honoursFetch) {
        throw new Error(
          `The ${parsed.provider} Provider doesn't declare honoursFetch, so a linked plan's Models can't run on it`,
        );
      }
      return abortable(
        provider.text(
          parsed.modelId,
          credentials,
          options?.linked ? { fetch: chatgptPlanFetch() } : {},
        ),
      );
    },
    imageAdapterFor(model: string, credentials: Credentials): AnyImageAdapter {
      const parsed = parseModelId(model);
      if (!parsed) throw new Error(`"${model}" is not an Image Model`);
      const image = providers[parsed.provider]?.image;
      if (!image) {
        throw new Error(`No image adapter is available for the ${parsed.provider} Provider`);
      }
      return image(parsed.modelId, credentials);
    },
  };
}

/**
 * `adapter` with the run's abort signal added to every request it sends through `wrapFetch`.
 * Some stock adapters (Mistral's) don't hand the signal to their fetch, so Stop would leave the
 * request running (issue #54). An adapter whose requests don't go through `wrapFetch` (Bedrock's,
 * on the AWS SDK) needs a Host-side fix.
 */
function abortable(adapter: AnyTextAdapter): AnyTextAdapter {
  return new Proxy(adapter, {
    get(target, key) {
      if (key === "chatStream") {
        return (options: Parameters<AnyTextAdapter["chatStream"]>[0]) =>
          target.chatStream(withRunSignal(options));
      }
      if (key === "structuredOutput") {
        return (options: Parameters<AnyTextAdapter["structuredOutput"]>[0]) =>
          target.structuredOutput({ ...options, chatOptions: withRunSignal(options.chatOptions) });
      }
      // Optional: the chat engine calls it in place of `structuredOutput` when the adapter has it.
      if (key === "structuredOutputStream" && target.structuredOutputStream) {
        const stream = target.structuredOutputStream.bind(target);
        return (options: Parameters<typeof stream>[0]) =>
          stream({ ...options, chatOptions: withRunSignal(options.chatOptions) });
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `options` with a `wrapFetch` that adds the run's abort signal to every fetch. */
function withRunSignal<T extends Pick<TextOptions, "request" | "wrapFetch">>(options: T): T {
  const signal = options.request?.signal;
  if (!signal) return options;
  const { wrapFetch } = options;
  return {
    ...options,
    wrapFetch: (next: typeof fetch): typeof fetch => {
      const base = wrapFetch ? wrapFetch(next) : next;
      return (input, init) =>
        base(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        });
    },
  };
}

/** The size each image adapter takes for each aspect ratio, from its own size rules (spec #278). */
type SizeTable = Record<AspectRatio, string>;

const gptImageSizes: SizeTable = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/**
 * The size table of an Image Model. Each Provider's sizes come from its TanStack AI package
 * (validated there, so a value outside its list is refused by the adapter): OpenAI and the
 * gpt-image Models on Lovable, Vercel and Cloudflare take WIDTHxHEIGHT; Gemini's Models take
 * `aspect_resolution`; Grok takes an aspect ratio; BytePlus takes pixels at 2K.
 */
function sizeTableFor(provider: string, modelId: string): SizeTable {
  switch (provider) {
    case "openai":
      if (modelId === "dall-e-2") {
        return { square: "1024x1024", landscape: "1024x1024", portrait: "1024x1024" };
      }
      if (modelId === "dall-e-3") {
        return { square: "1024x1024", landscape: "1792x1024", portrait: "1024x1792" };
      }
      return gptImageSizes;
    case "gemini":
      // Every Gemini Image Model is a native one since TanStack AI 1.0 dropped Imagen.
      return { square: "1:1_1K", landscape: "16:9_1K", portrait: "9:16_1K" };
    case "grok":
      return { square: "1:1", landscape: "16:9", portrait: "9:16" };
    case "byteplus":
      return { square: "2048x2048", landscape: "2560x1440", portrait: "1440x2560" };
    case "openrouter":
      return { square: "1024x1024", landscape: "1248x832", portrait: "832x1248" };
    case "lovable":
    case "vercel-gateway":
    case "cloudflare":
      return gptImageSizes;
    default:
      throw new Error(`No image sizes are known for the ${provider} Provider`);
  }
}

/** Providers whose image adapter takes a GPT-style `quality` (`low`, `medium`, `high`). */
const qualityProviders = new Set(["openai", "lovable"]);

/**
 * The size and provider options one `generate_image` call sends (spec #278). On Host credentials
 * the Host Image Model's pinned size and quality are used whatever the aspect ratio, so the flat
 * price is accurate. On a user's own credentials the aspect ratio maps to the nearest size the
 * adapter takes, and the quality is the adapter's default.
 */
export type ImageRequest = { size: string; modelOptions?: { quality: string } };

export function imageRequestFor(
  model: string,
  aspectRatio: AspectRatio,
  pinned?: { size: string; quality: string },
): ImageRequest {
  const parsed = parseModelId(model);
  if (!parsed) throw new Error(`"${model}" is not an Image Model`);
  if (!pinned) return { size: sizeTableFor(parsed.provider, parsed.modelId)[aspectRatio] };
  if (!qualityProviders.has(parsed.provider)) return { size: pinned.size };
  return { size: pinned.size, modelOptions: { quality: pinned.quality } };
}
