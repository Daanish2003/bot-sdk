import { fakeImageModel, fakeModel } from "../../../packages/chat-sdk/test/e2e/fake-ollama.ts";

/** Where the end-to-end run's server, fake Ollama and fake MCP server live. */

export const port = 3100;
export const baseURL = `http://localhost:${port}`;
export const fakeOllamaPort = 11534;
export const fakeOllamaHost = `http://localhost:${fakeOllamaPort}`;
export const fakeMcpPort = 11600;

/**
 * The second server, which offers one MCP server (the `MCP_SERVER_*` variables). The default
 * server offers none, so its tests see no Connections. Both share the database.
 */
export const mcpPort = 3101;
export const mcpBaseURL = `http://localhost:${mcpPort}`;
export const fakeMcpClientId = "ai-chat-e2e";
export const fakeMcpClientSecret = "e2e-mcp-client-secret-not-for-production";

/**
 * The server's environment: fixed secrets, never used outside these tests. Its database is
 * picked by `start-server.ts`.
 */
export const serverEnv = {
  NODE_ENV: "production",
  PORT: String(port),
  BETTER_AUTH_URL: baseURL,
  BETTER_AUTH_SECRET: "e2e-better-auth-secret-not-for-production",
  KEY_ENCRYPTION_SECRET: "e2e-key-encryption-secret-not-for-production",
  // Mail goes to the capture mailbox, read back through /api/test-mailbox. Nothing is sent, so
  // the Resend key is a placeholder (production requires one).
  EMAIL_TRANSPORT: "capture",
  EMAIL_FROM: "AI Chat <no-reply@example.com>",
  APP_NAME: "AI Chat",
  RESEND_API_KEY: "re_e2e_not_sent",
  // OAuth client ids and secrets for the login buttons' start URLs. Nothing calls the providers.
  GITHUB_CLIENT_ID: "e2e-github-client-id",
  GITHUB_CLIENT_SECRET: "e2e-github-client-secret-not-for-production",
  GOOGLE_CLIENT_ID: "e2e-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "e2e-google-client-secret-not-for-production",
  // The fake page `fetch_url` reads is served by the fake Ollama host, on localhost (see fake-ollama.ts).
  SSRF_ALLOW_HOSTS: `localhost:${fakeOllamaPort}`,
  // The Host's own Models (ADR 0007): the fake Ollama host is the Host's Provider, so a user with no
  // key of their own can chat on it. The fake Model reports one input and one output token, which
  // these prices cost $2 in all: over the $1 daily Quota after one Run.
  HOST_PROVIDER: "ollama",
  HOST_CREDENTIALS: JSON.stringify({ host: fakeOllamaHost }),
  HOST_MODELS: JSON.stringify([
    {
      modelId: fakeModel,
      tools: true,
      maxOutputTokens: 1024,
      inputUsdPerMillion: 1_000_000,
      outputUsdPerMillion: 1_000_000,
    },
  ]),
  HOST_QUOTA_BUDGET_USD: "1",
  HOST_QUOTA_WINDOW: "day",
  // The Background Model the Memory job calls (#290). The e2e user brings their own Ollama key
  // (`addFakeOllama`), so these calls are not metered against the Quota.
  HOST_BACKGROUND_MODEL: `ollama:${fakeModel}`,
  // Knowledge's embedding Model (spec #357): the fake adapter answers it, and the Host offers
  // text-embedding-3-small on a fake key, so no paid Provider is called.
  HOST_EMBEDDING_PROVIDER: "fake",
  // The Host's Image Model (spec #278): the fake adapter answers it, so no paid Provider is called.
  HOST_IMAGE_PROVIDER: "fake",
  HOST_IMAGE_CREDENTIALS: JSON.stringify({ apiKey: "e2e-not-sent" }),
  HOST_IMAGE_MODELS: JSON.stringify([
    { modelId: fakeImageModel, size: "1024x1024", quality: "medium", pricePerImageUsd: 0.01 },
  ]),
  HOST_DEFAULT_IMAGE_MODEL: `fake:${fakeImageModel}`,
  // Set only by a run with Redis (`redis.spec.ts`); otherwise the server runs on memory.
  ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
};

/**
 * The MCP server's environment: `serverEnv` with its own address, the fake MCP server's
 * localhost allowance (the SSRF guard's test-only list) and the one MCP server `apps/web` offers.
 */
export const mcpServerEnv = {
  ...serverEnv,
  PORT: String(mcpPort),
  BETTER_AUTH_URL: mcpBaseURL,
  SSRF_ALLOW_HOSTS: `localhost:${fakeMcpPort}`,
  MCP_SERVER_KEY: "tracker",
  MCP_SERVER_NAME: "E2E Tracker",
  MCP_SERVER_URL: `http://localhost:${fakeMcpPort}/mcp`,
  MCP_SERVER_OAUTH_CLIENT_ID: fakeMcpClientId,
  MCP_SERVER_OAUTH_CLIENT_SECRET: fakeMcpClientSecret,
};
