import { createBotSdk } from "@ai-chat/bot-sdk/core/server";
import { assistant, type HostToolContext } from "@ai-chat/bot-sdk/plugins/assistant/server";
import { bot } from "@ai-chat/bot-sdk/plugins/bot/server";
import { fakeEmailProvider } from "@ai-chat/bot-sdk/plugins/channel/fake";
import { channel, emailChannel } from "@ai-chat/bot-sdk/plugins/channel/server";
import { e2bProvider } from "@ai-chat/bot-sdk/plugins/computer/e2b";
import { computer } from "@ai-chat/bot-sdk/plugins/computer/server";
import { knowledge } from "@ai-chat/bot-sdk/plugins/knowledge/server";
import { memory } from "@ai-chat/bot-sdk/plugins/memory/server";
import { models } from "@ai-chat/bot-sdk/plugins/models/server";
import { runner } from "@ai-chat/bot-sdk/plugins/runner/server";
import { skills } from "@ai-chat/bot-sdk/plugins/skills/server";
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/db";

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
      ? [computer({ provider: e2bProvider({ ...e2b, template: "ai-chat-computer-v3" }) })]
      : []),
    memory(),
    // Skills (spec #713): each Bot's SKILL.md files, listed in its prompt; on only with the Computer.
    skills(),
    // Knowledge (spec #737): the user's shared Knowledge files on their Computer, and text extraction.
    knowledge(),
    assistant({ tools: [serverTime] }),
    // `reviewModel` is optional: the Model that reviews each Bot's risky tool calls (Auto-review).
    // Without it, or when the user can't use it, the Bot's own Model reviews.
    bot({ reviewModel: "openai:gpt-6-luna" }),
    // Channels (spec #761): each Bot's email address, on the fake provider (its DMARC verdict comes
    // from the request). The example has no inbound route, so nothing reaches a Bot from outside.
    channel({
      adapters: [
        emailChannel({
          provider: fakeEmailProvider().provider,
          domain: "bots.localhost",
          appUrl: "http://localhost:3000",
        }),
      ],
      // Only the user's own stored email reaches their Bots (the example has no email verification).
      verifiedEmail: async (userId) => {
        const row = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        return row?.email ?? null;
      },
    }),
  ],
});
