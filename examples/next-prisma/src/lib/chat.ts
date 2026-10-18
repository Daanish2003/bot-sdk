import { createBotSdk } from "@ai-chat/bot-sdk/core/server";
import { assistant, type HostToolContext } from "@ai-chat/bot-sdk/plugins/assistant/server";
import { e2bProvider } from "@ai-chat/bot-sdk/plugins/computer/e2b";
import { computer } from "@ai-chat/bot-sdk/plugins/computer/server";
import { models } from "@ai-chat/bot-sdk/plugins/models/server";
import { runner } from "@ai-chat/bot-sdk/plugins/runner/server";
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { auth } from "@/auth";

/**
 * A Host tool: the Model can ask for the server's time. `fn` runs on this server; the context
 * carries the user's and the Conversation's ids. Kept deliberately trivial: it shows the `tools`
 * contract works end to end (CI covers it).
 */
const serverTime = toolDefinition({
  name: "server_time",
  description: "The current time on the server, as an ISO 8601 string in UTC.",
  inputSchema: z.object({}),
}).server<HostToolContext>(() => ({ now: new Date().toISOString() }));

/**
 * The Computer plugin, on only when all three self-hosted E2B variables are set (spec #519). The
 * template name matches the SDK's Dockerfile version.
 */
const e2b =
  process.env.E2B_API_KEY && process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL
    ? {
        apiKey: process.env.E2B_API_KEY,
        apiUrl: process.env.E2B_API_URL,
        sandboxUrl: process.env.E2B_SANDBOX_URL,
      }
    : undefined;

/**
 * The Bot SDK for this app. Built at import time with no side effects: nothing connects until a
 * request, `start()` or `migrate()`.
 */
export const chat = createBotSdk({
  databaseUrl: process.env.DATABASE_URL ?? "",
  keyEncryptionSecrets: [process.env.KEY_ENCRYPTION_SECRET ?? ""],
  basePath: "/api/chat",
  getUser: async () => {
    const session = await auth();
    return session ? { id: session.user.id } : null;
  },
  plugins: [
    models(),
    runner(),
    ...(e2b
      ? [computer({ provider: e2bProvider({ ...e2b, template: "ai-chat-computer-v1" }) })]
      : []),
    assistant({ tools: [serverTime] }),
  ],
});
