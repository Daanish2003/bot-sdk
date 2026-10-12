import type { ProviderId } from "../credentials/services";
import { modelsDevSnapshot } from "./models-snapshot";

/**
 * The curated Model list: plain data, safe to import into the browser. Every `modelId` must be
 * in its adapter package's `*_MODELS` export (checked in `models.test.ts`). Capability flags
 * follow each package's model metadata. The limits and reasoning efforts come from the reviewed
 * models.dev snapshot (`models-snapshot.ts`, `pnpm snapshot:models`).
 */

/** A reasoning effort the chat offers. `off` is separate: see `ReasoningSupport`. */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * What a Model's reasoning setting takes. `efforts` is empty when the Model has no control to
 * show. `defaultEffort` is `"off"` or an effort the Provider uses when none is sent, or `null`
 * when that isn't known.
 */
export type ReasoningSupport = {
  efforts: ReasoningEffort[];
  off: boolean;
  defaultEffort: ReasoningEffort | "off" | null;
};

/** The reasoning support of a Model with no known control: no efforts, no `off`, no default. */
export function unknownReasoning(): ReasoningSupport {
  return { efforts: [], off: false, defaultEffort: null };
}

/** A reasoning choice a Conversation stores: `off` or an effort. `null` is the Model's default. */
export type ReasoningChoice = ReasoningEffort | "off";

const choiceLabels: Record<ReasoningChoice, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** How a reasoning choice reads in the UI; `null` is the Model's default. */
export function reasoningChoiceLabel(choice: ReasoningChoice | null): string {
  return choice === null ? "Model default" : choiceLabels[choice];
}

/** Providers whose adapters take no reasoning setting here, so their Models offer no choice. */
const noReasoningControl = new Set(["mistral", "bedrock", "ollama"]);

/** The choices the reasoning control offers for a Model: `off` where allowed, then its efforts. Empty hides the control. */
export function reasoningChoices(model: {
  provider: string;
  reasoning: ReasoningSupport;
}): ReasoningChoice[] {
  if (noReasoningControl.has(model.provider)) return [];
  return [...(model.reasoning.off ? (["off"] as const) : []), ...model.reasoning.efforts];
}

/** The effort a Run sends for a Conversation's stored choice: the choice when the Model offers it, else `undefined` (the Model's default). */
export function effortFor(
  model: { provider: string; reasoning: ReasoningSupport },
  stored: ReasoningChoice | null,
): ReasoningChoice | undefined {
  if (stored === null) return undefined;
  return reasoningChoices(model).includes(stored) ? stored : undefined;
}

export type CuratedModel = {
  /** `"provider:model"`, as stored in `conversation.model` and `message.model`. */
  id: string;
  provider: ProviderId;
  modelId: string;
  label: string;
  images: boolean;
  pdfs: boolean;
  tools: boolean;
  /** Tokens the Model reads in one request. `null` when unknown: never a guess. */
  contextWindow: number | null;
  /** Tokens the Model writes in one reply. `null` when unknown. */
  maxOutputTokens: number | null;
  reasoning: ReasoningSupport;
};

/** A Model the user can pick (`models.list`). `onHostCredentials`: a Host pays for it (ADR 0007). */
export type ListedModel = CuratedModel & { onHostCredentials: boolean };

function model(
  provider: ProviderId,
  modelId: string,
  label: string,
  capabilities: Pick<CuratedModel, "images" | "pdfs" | "tools">,
): CuratedModel {
  const id = `${provider}:${modelId}`;
  const limits = modelsDevSnapshot[id];
  return {
    id,
    provider,
    modelId,
    label,
    ...capabilities,
    contextWindow: limits?.contextWindow ?? null,
    maxOutputTokens: limits?.maxOutputTokens ?? null,
    reasoning: limits
      ? { efforts: [...limits.efforts], off: limits.off, defaultEffort: null }
      : unknownReasoning(),
  };
}

const anthropic = { images: true, pdfs: true, tools: true };
const openai = { images: true, pdfs: false, tools: true };
// PDFs only reach a Model through an adapter that sends document parts (native, Converse or
// Responses); Chat-Completions-based adapters can't, so their Models have PDFs off.
const all = { images: true, pdfs: true, tools: true };
const imagesAndTools = { images: true, pdfs: false, tools: true };
const textAndTools = { images: false, pdfs: false, tools: true };

export const curatedModels: CuratedModel[] = [
  model("anthropic", "claude-opus-5-5", "Claude Opus 5.5", anthropic),
  model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", anthropic),
  model("anthropic", "claude-fable-5-1", "Claude Fable 5.1", anthropic),
  model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", anthropic),
  model("openai", "gpt-6.1-sol", "GPT-6.1 Sol", openai),
  model("openai", "gpt-6-luna", "GPT-6 Luna", openai),
  model("openai", "gpt-5.6", "GPT-5.6", openai),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini", openai),
  model("gemini", "gemini-3.8-flash", "Gemini 3.8 Flash", all),
  model("gemini", "gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", all),
  model("gemini", "gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)", all),
  model("gemini", "gemini-2.5-pro", "Gemini 2.5 Pro", all),
  model("mistral", "mistral-medium-latest", "Mistral Medium", imagesAndTools),
  model("mistral", "mistral-large-latest", "Mistral Large", textAndTools),
  model("mistral", "mistral-small-latest", "Mistral Small", imagesAndTools),
  model("mistral", "magistral-medium-latest", "Magistral Medium", textAndTools),
  model("mistral", "codestral-latest", "Codestral", textAndTools),
  model("groq", "openai/gpt-oss-120b", "GPT-OSS 120B", textAndTools),
  model("groq", "llama-3.3-70b-versatile", "Llama 3.3 70B", textAndTools),
  model(
    "groq",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "Llama 4 Maverick",
    imagesAndTools,
  ),
  model("groq", "moonshotai/kimi-k2-instruct-0905", "Kimi K2", textAndTools),
  model("groq", "qwen/qwen3-32b", "Qwen3 32B", textAndTools),
  model("grok", "grok-4.7", "Grok 4.7", all),
  model("grok", "grok-4.6", "Grok 4.6", all),
  model("grok", "grok-4.3", "Grok 4.3", imagesAndTools),
  model("grok", "grok-build-0.1", "Grok Build 0.1", imagesAndTools),
  model("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "Claude Sonnet 4.5", all),
  model("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "Claude Haiku 4.5", all),
  model("bedrock", "us.amazon.nova-pro-v1:0", "Amazon Nova Pro", all),
  model("bedrock", "us.meta.llama4-maverick-17b-instruct-v1:0", "Llama 4 Maverick", imagesAndTools),
  model("bedrock", "openai.gpt-oss-120b-1:0", "GPT-OSS 120B", textAndTools),
  model("cloudflare", "@cf/openai/gpt-oss-120b", "GPT-OSS 120B", textAndTools),
  model("cloudflare", "@cf/meta/llama-4-scout-17b-16e-instruct", "Llama 4 Scout", imagesAndTools),
  model("cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "Llama 3.3 70B", textAndTools),
  model("cloudflare", "@cf/moonshotai/kimi-k2.6", "Kimi K2.6", textAndTools),
  model("cloudflare", "@cf/zai-org/glm-4.7-flash", "GLM-4.7 Flash", textAndTools),
  model("byteplus", "seed-2-0-lite-260428", "Seed 2.0 Lite", imagesAndTools),
  model("byteplus", "seed-2-0-pro-260328", "Seed 2.0 Pro", imagesAndTools),
  model("byteplus", "seed-2-0-mini-260428", "Seed 2.0 Mini", imagesAndTools),
  model("byteplus", "glm-5-2-260617", "GLM-5.2", textAndTools),
  model("llmgateway", "claude-sonnet-5", "Claude Sonnet 5", imagesAndTools),
  model("llmgateway", "gpt-5.6-terra", "GPT-5.6 Terra", imagesAndTools),
  model("llmgateway", "gemini-3.6-flash", "Gemini 3.6 Flash", imagesAndTools),
  model("llmgateway", "kimi-k3", "Kimi K3", imagesAndTools),
  model("llmgateway", "deepseek-v4-pro", "DeepSeek V4 Pro", textAndTools),
  model("lovable", "google/gemini-3.7-flash", "Gemini 3.7 Flash", imagesAndTools),
  model("lovable", "google/gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)", imagesAndTools),
  model("lovable", "openai/gpt-5.6-sol", "GPT-5.6 Sol", imagesAndTools),
  model("lovable", "openai/gpt-5.4-mini", "GPT-5.4 mini", imagesAndTools),
  model("vercel-gateway", "anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", all),
  model("vercel-gateway", "openai/gpt-6.1-sol", "GPT-6.1 Sol", all),
  model("vercel-gateway", "google/gemini-3.8-flash", "Gemini 3.8 Flash", all),
  model("vercel-gateway", "spacexai/grok-4.7", "Grok 4.7", imagesAndTools),
  model("vercel-gateway", "moonshotai/kimi-k3", "Kimi K3", all),
];

/** The Provider part of a `"provider:model"` id, curated or not. */
export function providerOf(id: string): string {
  const [provider = id] = id.split(":");
  return provider;
}

/**
 * Providers whose Models are listed live instead of curated: OpenRouter's models API and the
 * Models installed on the user's Ollama host (`chat/live-models.ts`).
 */
const liveListProviders: ProviderId[] = ["openrouter", "ollama"];

export function isLiveListProvider(provider: string) {
  return (liveListProviders as string[]).includes(provider);
}

/** Splits a `"provider:model"` id at its first colon (Ollama model ids contain colons too). */
export function parseModelId(id: string): { provider: string; modelId: string } | undefined {
  const separator = id.indexOf(":");
  if (separator < 0) return undefined;
  return { provider: id.slice(0, separator), modelId: id.slice(separator + 1) };
}

/** The curated Model for a `"provider:model"` id, or `undefined`. */
export function findModel(id: string): CuratedModel | undefined {
  return curatedModels.find((model) => model.id === id);
}

/** Whether `id` names a Model: a curated one, or any Model of a live-listed Provider. */
export function isKnownModel(id: string) {
  const parsed = parseModelId(id);
  return !!parsed && (!!findModel(id) || isLiveListProvider(parsed.provider));
}

/** The Model a new Conversation starts on when the Provider is the first one the user added. */
const providerDefaults: Partial<Record<ProviderId, string>> = {
  anthropic: "anthropic:claude-sonnet-5-5",
  openai: "openai:gpt-5.6",
  gemini: "gemini:gemini-3.8-flash",
  openrouter: "openrouter:anthropic/claude-sonnet-5.5",
  mistral: "mistral:mistral-medium-latest",
  groq: "groq:openai/gpt-oss-120b",
  grok: "grok:grok-4.7",
  bedrock: "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  cloudflare: "cloudflare:@cf/openai/gpt-oss-120b",
  byteplus: "byteplus:seed-2-0-lite-260428",
  llmgateway: "llmgateway:claude-sonnet-5",
  lovable: "lovable:google/gemini-3.7-flash",
  "vercel-gateway": "vercel-gateway:anthropic/claude-sonnet-5.5",
};

/** The code default Model of `provider`: its chosen default, else its first curated Model. */
export function defaultModelFor(provider: ProviderId): string | undefined {
  return (
    providerDefaults[provider] ?? curatedModels.find((model) => model.provider === provider)?.id
  );
}
