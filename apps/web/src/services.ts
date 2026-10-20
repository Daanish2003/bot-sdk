import { createAuth } from "@ai-chat/auth";
import { chatgptAccessToken } from "@ai-chat/auth/chatgpt";
import { createDb } from "@ai-chat/db";
import {
  createBotSdk,
  memoryRuntime,
  redisRuntime,
  redisStore,
} from "@ai-chat/bot-sdk/core/server";
import { assistant } from "@ai-chat/bot-sdk/plugins/assistant/server";
import { bot } from "@ai-chat/bot-sdk/plugins/bot/server";
import {
  fakeEmbeddingAdapter,
  fakeImageAdapter,
  models,
} from "@ai-chat/bot-sdk/plugins/models/server";
import { runner } from "@ai-chat/bot-sdk/plugins/runner/server";
import { log } from "evlog";

import { isBanActive } from "./admin/ban";
import { appName, sender } from "./email";
import { ENV, ssrfAllowHosts } from "./env.server";
import { blobStoreOf } from "./blob-store";
import { getQuota } from "./admin/quota";
import {
  hostBackgroundModelOf,
  hostDefaultImageModelOf,
  hostEmbeddingProvidersOf,
  hostImageProvidersOf,
  hostProvidersOf,
  quotaOf,
} from "./host-models";
import { linkedCredentialsOf } from "./linked-credentials";
import { computerPluginsOf } from "./computer";
import { mcpServersOf } from "./mcp-server";
import { trustedIpHeadersOf } from "./trusted-ip";

// The template Computers are built from, named by its version (spec #519). It matches the SDK's
// Dockerfile, built into E2B as this name; changing it rebuilds every Computer on its next wake.
export const computerTemplate = "ai-chat-computer-v3";

// The three E2B values are set together or not at all, so a typo does not silently turn Computers off.
const e2bValues = [ENV.E2B_API_KEY, ENV.E2B_API_URL, ENV.E2B_SANDBOX_URL];
if (e2bValues.some(Boolean) && !e2bValues.every(Boolean)) {
  throw new Error("E2B_API_KEY, E2B_API_URL and E2B_SANDBOX_URL are set together or not at all");
}
const e2b =
  ENV.E2B_API_KEY && ENV.E2B_API_URL && ENV.E2B_SANDBOX_URL
    ? { apiKey: ENV.E2B_API_KEY, apiUrl: ENV.E2B_API_URL, sandboxUrl: ENV.E2B_SANDBOX_URL }
    : undefined;

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
    CHATGPT_CLIENT_ID: ENV.CHATGPT_CLIENT_ID,
    CHATGPT_HOST_ID: ENV.CHATGPT_HOST_ID,
  },
  db,
  sender,
  log,
  {
    // Runs before the user is deleted: a failure aborts the account delete, so the user can retry.
    deleteChatData: (userId) => sdk.deleteUser(userId),
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
// The Nitro lifecycle plugin is bundled apart from the routes, so it loads its own copy of this
// module. Both share one Bot SDK, so the jobs the plugin's runner runs publish on the pub/sub the
// routes subscribe to (#290).
const shared = globalThis as typeof globalThis & { botSdk?: ReturnType<typeof createBotSdk> };
export const sdk = (shared.botSdk ??= createBotSdk({
  databaseUrl: ENV.DATABASE_URL,
  keyEncryptionSecrets: [ENV.KEY_ENCRYPTION_SECRET, ENV.KEY_ENCRYPTION_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret),
  ),
  runtime: ENV.REDIS_URL ? redisRuntime({ url: ENV.REDIS_URL }) : memoryRuntime(),
  logger: log,
  basePath: "/api/chat",
  fetchAllowHosts: ssrfAllowHosts,
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
  plugins: [
    models({
      // The Host's Models and their Quota (ADR 0007); unset, users chat only on their own keys.
      // The Host's Image Models (`HOST_IMAGE_*`) come as one more Provider entry beside its chat Models.
      // The embedding Models (`HOST_EMBEDDING_PROVIDER`) come beside them, offered for Knowledge (ADR 0014).
      hostProviders: [
        ...hostProvidersOf(ENV),
        ...hostImageProvidersOf(ENV),
        ...hostEmbeddingProvidersOf(ENV),
      ],
      // The Host's default Background Model for titles (`HOST_BACKGROUND_MODEL`), one of its Models.
      defaultBackgroundModel: hostBackgroundModelOf(ENV),
      // The Host's default Image Model (`HOST_DEFAULT_IMAGE_MODEL`), one of its Image Models.
      defaultImageModel: hostDefaultImageModelOf(ENV),
      // CI only (spec #278): HOST_IMAGE_PROVIDER=fake answers every image with the fake adapter, so no
      // paid call is made.
      ...(ENV.HOST_IMAGE_PROVIDER === "fake" && { imageAdapterFor: () => fakeImageAdapter() }),
      // CI only (spec #357, ticket #370): HOST_EMBEDDING_PROVIDER=fake answers every embedding with the
      // fake adapter, so Knowledge makes no paid call.
      ...(ENV.HOST_EMBEDDING_PROVIDER === "fake" && {
        embeddingAdapterFor: () => fakeEmbeddingAdapter(),
      }),
      // A user's Quota: an Admin's override, else the Host's default (spec #277).
      getQuota: (userId) => getQuota(db, ENV, userId),
      // A linked ChatGPT plan is the user's OpenAI credentials when they saved no key (ADR 0023).
      linkedCredentials: linkedCredentialsOf((userId) => chatgptAccessToken(auth, db, userId)),
    }),
    // Background jobs (ADR 0011): the in-process runner, which Knowledge and Memory share.
    runner(),
    // The Bots' Computer (spec #519): on only when self-hosted E2B is configured.
    ...(await computerPluginsOf(e2b, computerTemplate)),
    assistant({
      mcpServers: mcpServersOf(ENV),
      // Artifacts (spec #304): the assistant's create_artifact tool, the side panel and its version route.
      artifacts: true,
    }),
    // Bots (spec #463): the full-screen Bots app at /bots.
    bot(),
  ],
}));
