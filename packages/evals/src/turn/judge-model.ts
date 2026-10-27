// The judge Model and the API keys the Turn evals share (src/turn/run.ts and src/turn/ladder.ts),
// or the owner's ChatGPT plan in place of an OpenAI key (src/chatgpt-plan.ts).

import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import { chat } from "@tanstack/ai";
import { type OpenAIChatModel, createOpenaiChat } from "@tanstack/ai-openai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";

import { type ChatgptPlan, planJudgeCompletion } from "../chatgpt-plan";
import type { Complete } from "./queue-run";

/** The API key environment variable of each Provider the eval may use. */
export const keyVariables: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * The API key a real run uses for `model`, or `null` when `model` runs on the owner's ChatGPT plan.
 * Fails when neither is there; `what` names the Model in that message.
 */
export function keyFor(model: string, plan: ChatgptPlan | null, what = ""): string | null {
  if (plan?.serves(model)) return null;
  const variable = keyVariables[model.split(":")[0]!];
  return (
    (variable && process.env[variable]) ||
    fail(`${variable ?? `A key for ${model}`} is not set${what}`)
  );
}

/**
 * The judge's completion at temperature 0, on OpenAI, Anthropic or OpenRouter, or on the ChatGPT
 * plan when `apiKey` is `null` (no temperature there).
 */
export function judgeCompletion(
  model: string,
  apiKey: string | null,
  plan: ChatgptPlan | null,
): Complete {
  if (apiKey === null) {
    return plan ? planJudgeCompletion(model, plan) : fail(`No key for the judge "${model}"`);
  }
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
      threadId: "eval-judge",
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
