// The owner's linked ChatGPT plan, for the evals (#637). With `EVAL_CHATGPT_USER_ID` set, the plan's
// Models (`openai:gpt-6.1-sol`, `openai:gpt-6-luna`) run on that user's linked plan instead of an
// OpenAI key, the judge included. The token is read from the dev database through Better Auth, which
// refreshes it and writes the rotated tokens back, so the web app's link keeps working.
//
// `@ai-chat/auth` loads `@ai-chat/email`'s `.tsx` templates, which plain Node can't run, so it is
// imported only on the plan, after tsx's loader is registered. A run on keys loads as before.

import { chatgptPlanModels } from "@botsdk/client/models/credentials/services";
import { chat } from "@tanstack/ai";

import { adaptersOf } from "@botsdk/bot/models/internal";
import type { LinkedCredentialsHook } from "@botsdk/bot/models/internal";

import { testModelProviders } from "@ai-chat/test-support/model-providers";

/** The owner's linked plan: a fresh access token on each call, and the models plugin's hook over it. */
export type ChatgptPlan = {
  /** The token, refreshed by Better Auth when it is about to expire. Fails when the link is gone. */
  token: () => Promise<string>;
  /** The models plugin's `linkedCredentials`: every eval user gets the owner's plan. */
  linkedCredentials: LinkedCredentialsHook;
  /** Whether `model` runs on the plan: one of the plan's Models. */
  serves: (model: string) => boolean;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function required(name: string): string {
  return process.env[name] || fail(`${name} is not set (the ChatGPT plan; see src/turn/README.md)`);
}

/**
 * The plan, when `EVAL_CHATGPT_USER_ID` is set, else `null`. It reads the web app's own settings
 * (`apps/web/.env`): `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `CHATGPT_CLIENT_ID` and
 * `CHATGPT_HOST_ID`.
 */
export async function chatgptPlanFromEnv(): Promise<ChatgptPlan | null> {
  const userId = process.env.EVAL_CHATGPT_USER_ID;
  if (!userId) return null;
  const { register } = await import("tsx/esm/api");
  register();
  const { createAuth } = await import("@ai-chat/auth");
  const { chatgptAccessToken } = await import("@ai-chat/auth/chatgpt");
  const { createDb } = await import("@ai-chat/db");
  const database = createDb({ DATABASE_URL: required("DATABASE_URL") });
  const auth = createAuth(
    {
      BETTER_AUTH_URL: required("BETTER_AUTH_URL"),
      BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
      APP_NAME: "eval",
      // Only the ChatGPT provider is used: the others are never asked.
      GITHUB_CLIENT_ID: "unused",
      GITHUB_CLIENT_SECRET: "unused",
      GOOGLE_CLIENT_ID: "unused",
      GOOGLE_CLIENT_SECRET: "unused",
      CHATGPT_CLIENT_ID: required("CHATGPT_CLIENT_ID"),
      CHATGPT_HOST_ID: required("CHATGPT_HOST_ID"),
    },
    database,
    // No email is sent: the eval only reads the token.
    { send: async () => {} },
    { error: (entry) => console.error(entry.message, entry.error) },
    { deleteChatData: async () => {} },
    { rateLimit: false },
  );
  const token = async () => {
    const result = await chatgptAccessToken(auth, database, userId);
    if (result.status === "ok") return result.accessToken;
    throw new Error(
      result.status === "none"
        ? `User ${userId} has not linked ChatGPT: connect it on the web app's Keys page`
        : "The ChatGPT link is broken: reconnect it on the web app's Keys page",
    );
  };
  return {
    token,
    linkedCredentials: async () => ({ apiKey: await token() }),
    serves: (model) => chatgptPlanModels.includes(model),
  };
}

/**
 * The judge's completion on the plan. The plan refuses `temperature`, so the judge runs at the
 * Model's default and its verdicts can vary between runs. A fresh token is read for each prompt.
 */
export function planJudgeCompletion(model: string, plan: ChatgptPlan) {
  if (!plan.serves(model)) {
    fail(`The judge "${model}" is not a ChatGPT plan Model (${chatgptPlanModels.join(", ")})`);
  }
  return async (prompt: string) => {
    const adapter = adaptersOf(testModelProviders).adapterFor(
      model,
      { apiKey: await plan.token() },
      { linked: true },
    );
    const result = await chat({
      adapter,
      threadId: "eval-judge",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });
    return result.text;
  };
}
