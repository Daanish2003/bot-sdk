import { createAuth } from "@ai-chat/auth";
import { createDb } from "@ai-chat/db";
import {
  createChat,
  fakeImageAdapter,
  memoryRuntime,
  redisRuntime,
  redisStore,
} from "@ai-chat/chat-sdk/server";
import { log } from "evlog";

import { isBanActive } from "./admin/ban";
import { appName, sender } from "./email";
import { ENV, ssrfAllowHosts } from "./env.server";
import { blobStoreOf } from "./blob-store";
import { getQuota } from "./admin/quota";
import {
  hostBackgroundModelOf,
  hostDefaultImageModelOf,
  hostImageProvidersOf,
  hostProvidersOf,
  quotaOf,
} from "./host-models";
import { mcpServersOf } from "./mcp-server";
import { trustedIpHeadersOf } from "./trusted-ip";

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
    trustedIpHeaders: trustedIpHeadersOf(ENV),
  },
);
// The Host's default Quota is parsed at boot, so a bad HOST_QUOTA_* fails the start, not a Run.
void quotaOf(ENV);
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
  // The Host's Image Models (`HOST_IMAGE_*`) come as one more Provider entry beside its chat Models.
  hostProviders: [...hostProvidersOf(ENV), ...hostImageProvidersOf(ENV)],
  // The Host's default Background Model for titles (`HOST_BACKGROUND_MODEL`), one of its Models.
  defaultBackgroundModel: hostBackgroundModelOf(ENV),
  // The Host's default Image Model (`HOST_DEFAULT_IMAGE_MODEL`), one of its Image Models.
  defaultImageModel: hostDefaultImageModelOf(ENV),
  // CI only (spec #278): HOST_IMAGE_PROVIDER=fake answers every image with the fake adapter, so no
  // paid call is made.
  ...(ENV.HOST_IMAGE_PROVIDER === "fake" && { imageAdapterFor: () => fakeImageAdapter() }),
  // A user's Quota: an Admin's override, else the Host's default (spec #277).
  getQuota: (userId) => getQuota(db, ENV, userId),
  // File bytes go to the S3 store when S3_* is set, and to Postgres otherwise (ADR 0015).
  blobStore: blobStoreOf(ENV),
  // A banned user's Shared links are not found while the Ban holds (spec #277).
  isUserBlocked: async (userId) => {
    const row = await db.query.user.findFirst({
      where: { id: userId },
      columns: { banned: true, banExpires: true },
    });
    return row ? isBanActive(row, new Date()) : false;
  },
  getUser: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user ? { id: session.user.id } : null;
  },
});
