// What both Computer evals share: a scratch database, the real Computer on local E2B, and
// the `bot` plugin over it. Nothing here is the evals' own logic.

import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { databaseOf, postgresBlobStore, type Database } from "@botsdk/bot/storage";
import { createHookEmitter } from "@botsdk/bot/chat/hooks";
import type { FeatureEntry } from "@botsdk/bot/create-chat";
import { createGuardedFetch } from "@botsdk/bot/lib/guarded-fetch";
import { postgres } from "@botsdk/bot/database";
import { migrate as migrateBotSdk } from "@botsdk/bot/migrate";
import { sdkFeatureMigrations } from "../../scripts/migration-parts";
import type { BotSdkContext } from "@botsdk/bot/plugin";
import { memoryRuntime } from "@botsdk/bot/runtime";
import { createBotSdkOver, type OverSlots } from "@botsdk/bot/over";
import { e2bProvider } from "../../plugins/computer/e2b";
import type { ComputerProvider } from "@botsdk/bot/computer";
import { productionDeps } from "@botsdk/bot/models/internal";
import type { ModelsDeps } from "@botsdk/bot/models/internal";
import { testModelProviders } from "../../test/support/model-providers";

/** The key the eval's own credentials are encrypted with. Test data only: nothing is kept. */
const evalKeySecret = "eval-computer-key-secret-not-for-production";

/** The template the Host builds Computers from (`apps/web`'s `computerTemplate`). */
export const defaultTemplate = "ai-chat-computer-v3";

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The scratch database's URL, from `EVAL_DATABASE_URL`. */
export function databaseUrlFromEnv(): string {
  return process.env.EVAL_DATABASE_URL ?? fail("EVAL_DATABASE_URL is not set: a scratch Postgres.");
}

/** The local E2B's connection, from the three variables the Host uses. */
export function e2bFromEnv() {
  const { E2B_API_KEY: apiKey, E2B_API_URL: apiUrl, E2B_SANDBOX_URL: sandboxUrl } = process.env;
  if (!apiKey || !apiUrl || !sandboxUrl) {
    fail("E2B_API_KEY, E2B_API_URL and E2B_SANDBOX_URL must be set (see the SDK README).");
  }
  return { apiKey, apiUrl, sandboxUrl };
}

/** Makes the database's tables, as the test database does: the auth tables first, then the `botsdk` schema. */
export async function prepareSchema(url: string): Promise<Database> {
  const db = databaseOf(postgres({ connectionString: url }));
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../../db/src/migrations", import.meta.url)),
  });
  await migrateBotSdk(postgres({ connectionString: url }), sdkFeatureMigrations());
  return db;
}

/**
 * A real SDK instance over `db` with the Computer on `provider`, and the Bots.
 * `models` may replace the Models bundle (the dry run's fake Model); by default it is the real one.
 * `wrapFetch` may wrap the guarded fetch the SDK and the Models use (the ladder eval answers Tavily itself).
 */
export function createComputerSdk(
  options: OverSlots & {
    db: Database;
    provider: ComputerProvider;
    /** Features, such as `memory()`; they get the Computer. */
    features?: readonly FeatureEntry[];
    models?: (real: ModelsDeps) => ModelsDeps;
    wrapFetch?: (real: typeof globalThis.fetch) => typeof globalThis.fetch;
  },
) {
  const { db, provider, channels, users, reviewModel, features, models, wrapFetch } = options;
  const logger: Pick<Console, "error"> = console;
  const events = createHookEmitter(undefined, logger);
  const guarded = createGuardedFetch({ schemes: "http-and-https" });
  const fetch = wrapFetch ? wrapFetch(guarded) : guarded;
  const keyring = [evalKeySecret];
  const real = productionDeps({ db, keyring, events, logger, fetch } as unknown as BotSdkContext, {
    providers: testModelProviders,
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
      },
      models: models ? models(real) : real,
      computer: provider,
      channels,
      users,
      reviewModel,
      features,
    },
    { logger: { error: () => {} } },
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
