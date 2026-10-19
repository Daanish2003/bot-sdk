// The judge Model and the API keys the Turn evals share (eval/turn/run.ts and eval/turn/ladder.ts).

import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import { chat } from "@tanstack/ai";
import { type OpenAIChatModel, createOpenaiChat } from "@tanstack/ai-openai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";

import type { Complete } from "./queue-run";

/** The API key environment variable of each Provider the eval may use. */
export const keyVariables: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** The judge's completion at temperature 0, on OpenAI, Anthropic or OpenRouter (the pattern of eval/memory/run.ts). */
export function judgeCompletion(model: string, apiKey: string): Complete {
  const provider = model.split(":")[0]!;
  const modelId = model.slice(provider.length + 1);
  let adapter;
  if (provider === "openai") adapter = createOpenaiChat(modelId as OpenAIChatModel, apiKey);
  else if (provider === "anthropic") {
    adapter = createAnthropicChat(modelId as AnthropicChatModel, apiKey);
  } else if (provider === "openrouter") {
    adapter = createOpenRouterText(modelId as Parameters<typeof createOpenRouterText>[0], apiKey);
  } else fail(`EVAL_JUDGE_MODEL must be an openai, anthropic or openrouter Model, not "${model}"`);
  return async (prompt) => {
    const result = await chat({
      adapter,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      modelOptions: { temperature: 0 },
    });
    return result.text;
  };
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
