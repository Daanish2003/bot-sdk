import { createAuth } from "@ai-chat/auth";
import { createDb } from "@ai-chat/db";
import { createChat, memoryRuntime, redisRuntime } from "@ai-chat/chat-sdk/server";
import { log } from "evlog";

import { appName, sender } from "./email";
import { ENV, ssrfAllowHosts } from "./env.server";
import { mcpServersOf } from "./mcp-server";

export const db = createDb(ENV);
// The OAuth values are optional outside production (see .env.schema); an empty id makes the
// provider's sign-in fail at the provider rather than at boot.
export const auth = createAuth(
  {
    ...ENV,
    APP_NAME: appName,
    GITHUB_CLIENT_ID: ENV.GITHUB_CLIENT_ID ?? "",
    GITHUB_CLIENT_SECRET: ENV.GITHUB_CLIENT_SECRET ?? "",
    GOOGLE_CLIENT_ID: ENV.GOOGLE_CLIENT_ID ?? "",
    GOOGLE_CLIENT_SECRET: ENV.GOOGLE_CLIENT_SECRET ?? "",
  },
  db,
  sender,
  log,
  {
    // Runs before the user is deleted: a failure aborts the account delete, so the user can retry.
    deleteChatData: (userId) => chat.deleteUser(userId),
  },
);
export const chat = createChat({
  databaseUrl: ENV.DATABASE_URL,
  keyEncryptionSecrets: [ENV.KEY_ENCRYPTION_SECRET, ENV.KEY_ENCRYPTION_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret),
  ),
  runtime: ENV.REDIS_URL ? redisRuntime({ url: ENV.REDIS_URL }) : memoryRuntime(),
  logger: log,
  basePath: "/api/chat",
  fetchAllowHosts: ssrfAllowHosts,
  mcpServers: mcpServersOf(ENV),
  getUser: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user ? { id: session.user.id } : null;
  },
});
