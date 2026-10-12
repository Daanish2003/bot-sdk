import { createAuth } from "@ai-chat/auth";
import { createDb } from "@ai-chat/db";
import { createChat, memoryRuntime, redisRuntime, redisStore } from "@ai-chat/chat-sdk/server";
import { log } from "evlog";

import { appName, sender } from "./email";
import { ENV, ssrfAllowHosts } from "./env.server";
import { hostProvidersOf, quotaOf } from "./host-models";
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
  {
    // Limits are on, as in production; counted in Redis when REDIS_URL is set, so both processes share them.
    rateLimit: true,
    rateLimitCounter: ENV.REDIS_URL
      ? redisStore({ url: ENV.REDIS_URL, prefix: "auth:" })
      : undefined,
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
  // Artifacts (spec #304): the assistant's create_artifact tool, the side panel and its version route.
  artifacts: true,
  // The Host's Models and their Quota (ADR 0007); unset, users chat only on their own keys.
  hostProviders: hostProvidersOf(ENV),
  getQuota: quotaOf(ENV),
  getUser: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user ? { id: session.user.id } : null;
  },
});
