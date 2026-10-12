import { createChat, type HostToolContext } from "@/chat-sdk/core/server";
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
 * The Chat SDK for this app. Built at import time with no side effects: nothing connects until a
 * request, `start()` or `migrate()`.
 */
export const chat = createChat({
  databaseUrl: process.env.DATABASE_URL ?? "",
  keyEncryptionSecrets: [process.env.KEY_ENCRYPTION_SECRET ?? ""],
  basePath: "/api/chat",
  getUser: async () => {
    const session = await auth();
    return session ? { id: session.user.id } : null;
  },
  tools: [serverTime],
});
