// Loads the Bot SDK's TypeScript into plain Node: `node --import ./scripts/register-ts.mjs <file.ts>`.
// The SDK's files import each other without extensions, which Node's ESM resolver rejects; the hook
// in @botsdk/bot's bin/ts-extensionless.mjs adds `.ts` (or `/index.ts`) to those relative imports. Nothing else changes.
import { register } from "node:module";

register("@botsdk/bot/ts-extensionless", import.meta.url);
