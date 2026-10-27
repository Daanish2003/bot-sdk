/// <reference types="node" />
/**
 * Re-encrypts every stored secret under the newest key (ADR 0010), then prints
 * `{ reencrypted, unreadable }`. A one-off command: `docker compose run --rm web node scripts/rotate-keys.ts`
 * from the image, after the new keyring is live everywhere. Never in the pre-deploy step, where the
 * old version still writes under the old key. Remove the previous secret only once `unreadable` is 0.
 *
 * `pnpm db:rotate-keys` runs it with the local env from Varlock. Plain Node (type stripping), so the
 * SDK's extensionless imports are resolved by its hook, registered before the SDK is loaded.
 */
import { register } from "node:module";

import { log } from "evlog";

register("@botsdk/bot/ts-extensionless", import.meta.url);

const { createBotSdk, postgres } = await import("@botsdk/bot");
const { mcp } = await import("@botsdk/mcp");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const newest = process.env.KEY_ENCRYPTION_SECRET;
if (!newest) throw new Error("Set KEY_ENCRYPTION_SECRET");

// The keyring as apps/web/src/services.ts builds it: the newest secret first, then the previous one.
// What stores secrets: Provider and Tool credentials (models), Secrets (the Bot core) and
// Connection tokens (the mcp feature).
const sdk = createBotSdk({
  database: postgres({ connectionString: databaseUrl }),
  keyEncryptionSecrets: [newest, process.env.KEY_ENCRYPTION_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret),
  ),
  logger: log,
  models: {},
  features: [mcp()],
});

const result = await sdk.rotateKeys();
console.log(JSON.stringify(result));
await sdk.stop();
// A one-off command: it exits once it has printed, whatever handles are left.
process.exit(0);
