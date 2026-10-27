#!/usr/bin/env node
// `botsdk migrate [--config <file>] [--print] [--drop <feature>]`: loads the Host's config module
// (default `botsdk.config.ts`: its default export is the options the Host passes `createBotSdk`,
// and `disabled` may list features it once enabled, for `--drop`) and migrates.
// The SDK's TypeScript imports each other without extensions, so the resolve hook is registered first.
import { register } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

register("./ts-extensionless.mjs", import.meta.url);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "botsdk.config.ts" },
    print: { type: "boolean", default: false },
    drop: { type: "string" },
  },
});
if (positionals[0] !== "migrate") {
  console.error("Usage: botsdk migrate [--config <file>] [--print] [--drop <feature>]");
  process.exit(1);
}
const { runMigrate } = await import("../src/migrate-cli.ts");
const config = await import(pathToFileURL(resolve(values.config)).href);
await runMigrate(config, values, (text) => process.stdout.write(text));
// A Host's own pool or other handles in its config must not keep the CLI alive.
await new Promise((done) => process.stdout.write("", done));
process.exit(0);
