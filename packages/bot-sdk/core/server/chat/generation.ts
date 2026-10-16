import { parseModelId, type ReasoningEffort } from "../../shared/chat/models";

/**
 * The SDK's own generation settings for one Run. `effort` is `"off"` where the Model allows it,
 * and `undefined` when the Run sends no reasoning setting (the Model's default applies).
 */
export type GenerationSettings = {
  /** The Model's max output, or `null` when unknown: then no max output key is sent. */
  maxOutputTokens: number | null;
  effort?: ReasoningEffort | "off";
};

/** A Provider's `modelOptions` entries, as its TanStack AI adapter reads them. */
type ProviderOptions = Record<string, unknown>;

/** Maps the settings to one Provider's `modelOptions`, for the Model `id` (`"provider:model"`). */
type Mapper = (modelId: string, settings: GenerationSettings) => ProviderOptions;

/** The effort, as the Provider spells it when the chat turns reasoning on; `off` as its own word. */
const effortOrOff = (
  settings: GenerationSettings,
  on: (effort: ReasoningEffort) => ProviderOptions,
  off: ProviderOptions | undefined,
): ProviderOptions => {
  if (settings.effort === undefined) return {};
  if (settings.effort === "off") return off ?? {};
  return on(settings.effort);
};

const maxOutput = (key: string, { maxOutputTokens }: GenerationSettings): ProviderOptions =>
  maxOutputTokens === null ? {} : { [key]: maxOutputTokens };

/**
 * One mapping per Provider. Adding a setting later means one entry per Provider, not changes across
 * the Run.
 */
const mappers: Record<string, Mapper> = {
  anthropic: (_id, settings) => ({
    ...maxOutput("max_tokens", settings),
    // Adaptive thinking takes the effort; there is no budget to keep below max tokens.
    ...effortOrOff(settings, (effort) => ({ effort, thinking: { type: "adaptive" } }), {
      thinking: { type: "disabled" },
    }),
  }),
  openai: (_id, settings) => ({
    ...maxOutput("max_output_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning: { effort } }), {
      reasoning: { effort: "none" },
    }),
  }),
  gemini: (_id, settings) => ({
    ...maxOutput("maxOutputTokens", settings),
    // Gemini 3 cannot switch thinking fully off; `MINIMAL` is the closest level to `off`.
    ...effortOrOff(
      settings,
      (effort) => ({ thinkingConfig: { thinkingLevel: effort.toUpperCase() } }),
      { thinkingConfig: { thinkingLevel: "MINIMAL" } },
    ),
  }),
  openrouter: (_id, settings) => ({
    ...maxOutput("maxCompletionTokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning: { effort } }), {
      reasoning: { effort: "none" },
    }),
  }),
  // Mistral's adapter has no reasoning key, so its efforts are not sent.
  mistral: (_id, settings) => maxOutput("max_tokens", settings),
  groq: (_id, settings) => ({
    ...maxOutput("max_completion_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning_effort: effort }), {
      reasoning_effort: "none",
    }),
  }),
  grok: (id, settings) => ({
    ...maxOutput("max_output_tokens", settings),
    // grok-build-0.1 throws if reasoning is set on it at all.
    ...(id === "grok:grok-build-0.1"
      ? {}
      : effortOrOff(settings, (effort) => ({ reasoning: { effort } }), {
          reasoning: { effort: "none" },
        })),
  }),
  // Converse has no reasoning setting.
  bedrock: (_id, settings) => maxOutput("max_completion_tokens", settings),
  cloudflare: (_id, settings) => ({
    ...maxOutput("max_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning_effort: effort }), {
      reasoning_effort: null,
    }),
  }),
  // BytePlus rejects an effort together with thinking disabled, so `off` disables thinking instead.
  byteplus: (_id, settings) => ({
    ...maxOutput("max_completion_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning_effort: effort }), {
      thinking: { type: "disabled" },
    }),
  }),
  llmgateway: (_id, settings) => ({
    ...maxOutput("max_completion_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning_effort: effort }), {
      reasoning_effort: "none",
    }),
  }),
  // Lovable's reasoning takes a record or a boolean, not a level, so `off` is `false`.
  lovable: (_id, settings) => ({
    ...maxOutput("max_completion_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning: { effort } }), { reasoning: false }),
  }),
  "vercel-gateway": (_id, settings) => ({
    ...maxOutput("max_completion_tokens", settings),
    ...effortOrOff(settings, (effort) => ({ reasoning_effort: effort }), {
      reasoning_effort: "none",
    }),
  }),
};

/**
 * The `modelOptions` a Run sends to the adapter of the `"provider:model"` id, built from the
 * SDK's generation settings. The mapping is chosen by the Model's Provider, so any adapter that
 * reads these keys (the fake one in tests included) gets the same options.
 */
export function generationOptionsFor(id: string, settings: GenerationSettings): ProviderOptions {
  const provider = parseModelId(id)?.provider;
  const mapper = provider ? mappers[provider] : undefined;
  return mapper ? mapper(id, settings) : {};
}
