/// <reference types="node" />
/**
 * Re-encrypts every stored secret under the newest key (ADR 0010), then prints
 * `{ reencrypted, unreadable }`. A one-off command: `docker compose run --rm web node scripts/rotate-keys.ts`
 * from the image, after the new keyring is live everywhere. Never in the pre-deploy step, where the
 * old version still writes under the old key. Remove the previous secret only once `unreadable` is 0.
 *
 * `pnpm db:rotate-keys` runs it with the local env from Varlock. Plain Node (type stripping), so the
 * SDK's extensionless imports are resolved by the hook below before the SDK is loaded.
 */
import { registerHooks } from "node:module";

import { log } from "evlog";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // Try the next form of the path.
        }
      }
      throw error;
    }
  },
});

const { createChat } = await import("@ai-chat/chat-sdk/server");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");
const newest = process.env.KEY_ENCRYPTION_SECRET;
if (!newest) throw new Error("Set KEY_ENCRYPTION_SECRET");

// The keyring as apps/web/src/services.ts builds it: the newest secret first, then the previous one.
const chat = createChat({
  databaseUrl,
  keyEncryptionSecrets: [newest, process.env.KEY_ENCRYPTION_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret),
  ),
  basePath: "/api/chat",
  getUser: () => null,
  logger: log,
});

const result = await chat.rotateKeys();
console.log(JSON.stringify(result));
// The database pool has no public close; a one-off command exits once it has printed.
process.exit(0);
