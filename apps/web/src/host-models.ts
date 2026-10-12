import type { CreateChatOptions } from "@ai-chat/chat-sdk/server";
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
  HOST_QUOTA_BUDGET_USD?: string | undefined;
  HOST_QUOTA_WINDOW?: string | undefined;
};

type HostProviders = NonNullable<CreateChatOptions["hostProviders"]>;
type ProviderId = Extract<HostProviders[number], { models: unknown }>["provider"];
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
 * The one Quota for every user, from `HOST_QUOTA_BUDGET_USD` (in dollars) and `HOST_QUOTA_WINDOW`
 * (`day`, the default, or `month`). Unset, Host Models are unlimited.
 */
export function quotaOf(env: HostEnv): Quota | undefined {
  if (!isSet(env.HOST_QUOTA_BUDGET_USD)) return undefined;
  const budgetUsd = Number(env.HOST_QUOTA_BUDGET_USD);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error("HOST_QUOTA_BUDGET_USD must be a positive number of dollars");
  }
  const window = isSet(env.HOST_QUOTA_WINDOW) ? env.HOST_QUOTA_WINDOW.trim() : "day";
  if (window !== "day" && window !== "month") {
    throw new Error("HOST_QUOTA_WINDOW must be day or month");
  }
  return { budgetUsd, window };
}

function parseJson(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}
