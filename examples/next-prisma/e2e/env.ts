/** Where the example's end-to-end run listens, the fake Ollama host it uses, and its database. */

export const port = 3100;
export const baseURL = `http://localhost:${port}`;
export const fakeOllamaPort = 11534;
export const fakeOllamaHost = `http://localhost:${fakeOllamaPort}`;

/** The e2e database. It must exist before the run (CI creates it as the Postgres service's database). */
export const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:password@localhost:5432/ai-chat_e2e_example";

/** The server's environment: fixed secrets, never used outside these tests. */
export const serverEnv = {
  DATABASE_URL: e2eDatabaseUrl,
  AUTH_SECRET: "e2e-auth-secret-not-for-production",
  AUTH_TRUST_HOST: "true",
  KEY_ENCRYPTION_SECRET: "e2e-key-encryption-secret-not-for-production",
};
