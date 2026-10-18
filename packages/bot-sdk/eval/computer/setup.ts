// What both Computer evals share: a scratch database, the real `computer` plugin on local E2B, and
// the `bot` plugin over it. Nothing here is the evals' own logic.

import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { postgresBlobStore } from "../../core/server/blob/postgres";
import { createHookEmitter } from "../../core/server/chat/hooks";
import { createDb, type Database } from "../../core/server/db/index";
import { createGuardedFetch } from "../../core/server/lib/guarded-fetch";
import { migrate as migrateChatSchema } from "../../core/server/migrate";
import type { BotSdkContext, BotSdkPlugin } from "../../core/server/plugin";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { memoryRuntime } from "../../core/server/runtime";
import { createBotSdkOver } from "../../plugins/assistant/server/over";
import { e2bProvider } from "../../plugins/computer/e2b";
import { computer, type ComputerProvider } from "../../plugins/computer/server";
import { productionDeps } from "../../plugins/models/server/plugin";
import type { ModelsDeps } from "../../plugins/models/server/types";

/** The key the eval's own credentials are encrypted with. Test data only: nothing is kept. */
const evalKeySecret = "eval-computer-key-secret-not-for-production";

/** The template the Host builds Computers from (`apps/web`'s `computerTemplate`). */
export const defaultTemplate = "ai-chat-computer-v1";

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The scratch database's URL, from `EVAL_DATABASE_URL`. */
export function databaseUrlFromEnv(): string {
  return (
    process.env.EVAL_DATABASE_URL ??
    fail("EVAL_DATABASE_URL is not set: a scratch Postgres with pgvector.")
  );
}

/** The local E2B's connection, from the three variables the Host uses. */
export function e2bFromEnv() {
  const { E2B_API_KEY: apiKey, E2B_API_URL: apiUrl, E2B_SANDBOX_URL: sandboxUrl } = process.env;
  if (!apiKey || !apiUrl || !sandboxUrl) {
    fail("E2B_API_KEY, E2B_API_URL and E2B_SANDBOX_URL must be set (see the SDK README).");
  }
  return { apiKey, apiUrl, sandboxUrl };
}

/** Makes the database's tables, as the test database does: the auth tables first, then the chat schema. */
export async function prepareSchema(url: string): Promise<Database> {
  const db = createDb({ DATABASE_URL: url });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../../db/src/migrations", import.meta.url)),
  });
  await migrateChatSchema(url);
  return db;
}

/**
 * A real SDK instance over `db` with the `computer` plugin on `provider`, plus `more` plugins.
 * `models` may replace the Models bundle (the dry run's fake Model); by default it is the real one.
 */
export function createComputerSdk(options: {
  db: Database;
  provider: ComputerProvider;
  more?: readonly BotSdkPlugin[];
  models?: (real: ModelsDeps) => ModelsDeps;
}) {
  const { db, provider, more = [], models } = options;
  const logger: Pick<Console, "error"> = console;
  const events = createHookEmitter(undefined, logger);
  const fetch = createGuardedFetch({ schemes: "http-and-https" });
  const keyring = [evalKeySecret];
  const real = productionDeps({ db, keyring, events, logger, fetch } as unknown as BotSdkContext, {
    defaultBackgroundModel: undefined,
  });
  return createBotSdkOver(
    {
      context: {
        db,
        blobStore: postgresBlobStore(db),
        runtime: memoryRuntime(),
        logger,
        events,
        fetch,
        keyring,
        rateLimits: resolveRateLimits(),
      },
      models: models ? models(real) : real,
      assistant: { memory: false },
      plugins: [computer({ provider }), ...more],
    },
    { basePath: "/api/chat", getUser: () => null, logger: { error: () => {} } },
  ).sdk;
}

const placeAttempts = 4;

/** Retries a create or resume the local E2B could not place (it fits few sandboxes), with a short backoff. */
function retryPlacement<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(...args);
      } catch (caught) {
        const placement = caught instanceof Error && /Failed to place sandbox/.test(caught.message);
        if (!placement || attempt === placeAttempts) throw caught;
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      }
    }
  };
}

/** The E2B adapter on the local E2B, for the template `template`. */
export function localE2bProvider(template: string): ComputerProvider {
  const provider = e2bProvider({ ...e2bFromEnv(), template });
  return {
    ...provider,
    create: retryPlacement(provider.create),
    resume: retryPlacement(provider.resume),
  };
}
