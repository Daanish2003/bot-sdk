import type { ModelsOptions } from "@ai-chat/bot-sdk/plugins/models/server";
import { z } from "zod";

/**
 * The Host credentials and Quota `apps/web` offers, from its environment (ADR 0007). All five
 * variables are optional; set HOST_PROVIDER, HOST_CREDENTIALS and HOST_MODELS together or not at
 * all. Each is a string as the environment holds it, so this module parses it.
 */
export type HostEnv = {
  HOST_PROVIDER?: string | undefined;
  HOST_CREDENTIALS?: string | undefined;
  HOST_MODELS?: string | undefined;
  HOST_BACKGROUND_MODEL?: string | undefined;
  HOST_QUOTA_BUDGET_USD?: string | undefined;
  HOST_QUOTA_WINDOW?: string | undefined;
  HOST_IMAGE_PROVIDER?: string | undefined;
  HOST_IMAGE_CREDENTIALS?: string | undefined;
  HOST_IMAGE_MODELS?: string | undefined;
  HOST_DEFAULT_IMAGE_MODEL?: string | undefined;
};

type HostProviders = NonNullable<ModelsOptions["hostProviders"]>;
type HostProvider = Extract<HostProviders[number], { models: unknown }>;
type ProviderId = HostProvider["provider"];
type Quota = { budgetUsd: number; window: "day" | "month" };

const isSet = (value: string | undefined): value is string => (value?.trim() ?? "") !== "";

const hostModel = z.object({
  modelId: z.string().min(1),
  label: z.string().min(1).optional(),
  images: z.boolean().optional(),
  pdfs: z.boolean().optional(),
  tools: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive(),
  inputUsdPerMillion: z.number().nonnegative(),
  outputUsdPerMillion: z.number().nonnegative(),
  cacheReadUsdPerMillion: z.number().nonnegative().optional(),
  cacheWriteUsdPerMillion: z.number().nonnegative().optional(),
});

/** The Host's Provider credentials and Models, or none when the variables are unset. */
export function hostProvidersOf(env: HostEnv): HostProviders {
  const given = [env.HOST_PROVIDER, env.HOST_CREDENTIALS, env.HOST_MODELS].filter(isSet);
  if (given.length === 0) return [];
  if (given.length < 3) {
    throw new Error(
      "HOST_PROVIDER, HOST_CREDENTIALS and HOST_MODELS are set together or not at all",
    );
  }
  const credentials = z
    .record(z.string(), z.string().min(1))
    .parse(parseJson(env.HOST_CREDENTIALS, "HOST_CREDENTIALS"));
  const models = z
    .array(hostModel)
    .min(1, "HOST_MODELS needs at least one Model")
    .parse(parseJson(env.HOST_MODELS, "HOST_MODELS"));
  // The SDK checks the Provider id against its own list when it lists or runs a Model.
  const provider = env.HOST_PROVIDER!.trim() as ProviderId;
  return [{ provider, credentials, models }];
}

/**
 * The Host's default Background Model (`HOST_BACKGROUND_MODEL`), a `"provider:model"` id that must
 * name one of the Host's Models. Unset, users who pick none get the reply's Model for titles.
 */
export function hostBackgroundModelOf(env: HostEnv): string | undefined {
  if (!isSet(env.HOST_BACKGROUND_MODEL)) return undefined;
  const id = env.HOST_BACKGROUND_MODEL.trim();
  // Only a Provider entry carries Models; a Host Tool entry never comes from these variables.
  const offered = hostProvidersOf(env).flatMap((entry) =>
    "models" in entry ? entry.models.map((model) => `${entry.provider}:${model.modelId}`) : [],
  );
  if (!offered.includes(id)) {
    throw new Error("HOST_BACKGROUND_MODEL must name one of the HOST_MODELS, as provider:model");
  }
  return id;
}

const hostImageModel = z.object({
  modelId: z.string().min(1),
  size: z.string().min(1),
  quality: z.string().min(1),
  pricePerImageUsd: z.number().nonnegative(),
  imageInputPerMTok: z.number().nonnegative().optional(),
  imageOutputPerMTok: z.number().nonnegative().optional(),
  textInputPerMTok: z.number().nonnegative().optional(),
});

/**
 * The Host's Image Models (spec #278): one Provider entry with its Image Models, or none when the
 * variables are unset. Its `models` are empty, since it offers no chat Models.
 */
export function hostImageProvidersOf(env: HostEnv): HostProvider[] {
  const given = [env.HOST_IMAGE_PROVIDER, env.HOST_IMAGE_CREDENTIALS, env.HOST_IMAGE_MODELS].filter(
    isSet,
  );
  if (given.length === 0) return [];
  if (given.length < 3) {
    throw new Error(
      "HOST_IMAGE_PROVIDER, HOST_IMAGE_CREDENTIALS and HOST_IMAGE_MODELS are set together or not at all",
    );
  }
  const credentials = z
    .record(z.string(), z.string().min(1))
    .parse(parseJson(env.HOST_IMAGE_CREDENTIALS, "HOST_IMAGE_CREDENTIALS"));
  const imageModels = z
    .array(hostImageModel)
    .min(1, "HOST_IMAGE_MODELS needs at least one Model")
    .parse(parseJson(env.HOST_IMAGE_MODELS, "HOST_IMAGE_MODELS"));
  // The SDK checks the Provider id against its own list when it lists or runs a Model.
  const provider = env.HOST_IMAGE_PROVIDER!.trim() as ProviderId;
  return [{ provider, credentials, models: [], imageModels }];
}

/**
 * The Host's default Image Model (`HOST_DEFAULT_IMAGE_MODEL`), a `"provider:model"` id that must name
 * one of the HOST_IMAGE_MODELS. Unset, users who pick none get no images.
 */
export function hostDefaultImageModelOf(env: HostEnv): string | undefined {
  if (!isSet(env.HOST_DEFAULT_IMAGE_MODEL)) return undefined;
  const id = env.HOST_DEFAULT_IMAGE_MODEL.trim();
  const offered = hostImageProvidersOf(env).flatMap((entry) =>
    (entry.imageModels ?? []).map((model) => `${entry.provider}:${model.modelId}`),
  );
  if (!offered.includes(id)) {
    throw new Error(
      "HOST_DEFAULT_IMAGE_MODEL must name one of the HOST_IMAGE_MODELS, as provider:model",
    );
  }
  return id;
}

/**
 * The one Quota for every user, from `HOST_QUOTA_BUDGET_USD` (in dollars) and `HOST_QUOTA_WINDOW`
 * (`day`, the default, or `month`). Unset, Host Models are unlimited.
 */
export function quotaOf(env: HostEnv): Quota | undefined {
  if (!isSet(env.HOST_QUOTA_BUDGET_USD)) return undefined;
  const budgetUsd = Number(env.HOST_QUOTA_BUDGET_USD);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error("HOST_QUOTA_BUDGET_USD must be a positive number of dollars");
  }
  return { budgetUsd, window: quotaWindowOf(env) };
}

/** The window every Quota resets on, from `HOST_QUOTA_WINDOW`: `day` (the default) or `month`. */
export function quotaWindowOf(env: HostEnv): "day" | "month" {
  const window = isSet(env.HOST_QUOTA_WINDOW) ? env.HOST_QUOTA_WINDOW.trim() : "day";
  if (window !== "day" && window !== "month") {
    throw new Error("HOST_QUOTA_WINDOW must be day or month");
  }
  return window;
}

function parseJson(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}
