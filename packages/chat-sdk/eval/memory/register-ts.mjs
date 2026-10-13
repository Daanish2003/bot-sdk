// Loads the Chat SDK's TypeScript into plain Node: `node --import ./scripts/register-ts.mjs <file.ts>`.
// The SDK's files import each other without extensions, which Node's ESM resolver rejects; the hook
// in ts-extensionless.mjs adds `.ts` (or `/index.ts`) to those relative imports. Nothing else changes.
import { register } from "node:module";

register("./ts-extensionless.mjs", import.meta.url);
