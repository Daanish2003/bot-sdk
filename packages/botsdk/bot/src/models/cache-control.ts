import { normalizeSystemPrompts, type ModelMessage, type TextOptions } from "@tanstack/ai";

/** Anthropic's breakpoint: the cached prefix lives for an hour, not five minutes. */
const oneHour = { type: "ephemeral", ttl: "1h" } as const;

/**
 * `options` with the cache controls that keep a Bot's prompt cached on `provider` (#673):
 *
 * - Anthropic: a 1-hour breakpoint on the last system block and on the first message, and the
 *   automatic one on the request (`modelOptions.cache_control`), through the adapter's metadata.
 * - OpenAI, and the ChatGPT plan that sends through it: `prompt_cache_key` `key`. No retention is
 *   sent; the plan ignores it (probe #664).
 * - Any other Provider: `options` as they are.
 *
 * `key` is `bot:<botId>`, or `helper:<helperId>` for a Helper.
 */
export function withCacheControl(provider: string, key: string, options: TextOptions): TextOptions {
  if (provider === "openai") {
    return {
      ...options,
      modelOptions: { ...(options.modelOptions as object | undefined), prompt_cache_key: key },
    };
  }
  if (provider !== "anthropic") return options;

  const system = normalizeSystemPrompts(options.systemPrompts);
  const last = system.length - 1;
  const [first, ...rest] = options.messages as ModelMessage[];
  return {
    ...options,
    ...(last >= 0 && {
      systemPrompts: system.map((prompt, index) =>
        index === last
          ? {
              ...prompt,
              metadata: { ...(prompt.metadata as object | undefined), cache_control: oneHour },
            }
          : prompt,
      ),
    }),
    messages: first ? [breakpointOn(first), ...rest] : options.messages,
    modelOptions: { ...(options.modelOptions as object | undefined), cache_control: oneHour },
  };
}

/** A message with the breakpoint on its text: a string becomes one text part carrying it. */
function breakpointOn(message: ModelMessage): ModelMessage {
  const { content } = message;
  if (typeof content === "string") {
    return {
      ...message,
      content: [{ type: "text", content, metadata: { cache_control: oneHour } }],
    };
  }
  if (!Array.isArray(content)) return message;
  let lastText = -1;
  content.forEach((part, index) => {
    if (part.type === "text") lastText = index;
  });
  if (lastText < 0) return message;
  return {
    ...message,
    content: content.map((part, index) =>
      index === lastText
        ? {
            ...part,
            metadata: { ...(part.metadata as object | undefined), cache_control: oneHour },
          }
        : part,
    ),
  } as ModelMessage;
}
