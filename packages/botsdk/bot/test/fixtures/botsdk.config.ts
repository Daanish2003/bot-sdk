import type { BotSdkOptions } from "../../src/create-chat";
import { postgres } from "../../src/database";
import { mcp } from "@botsdk/mcp";
import { memory } from "@botsdk/memory";

// The config the `botsdk migrate` CLI test loads, shaped as a Host's: the factory's options (the
// test's database, with Connectors on), and Memory as a feature it once enabled.
export default {
  database: postgres({ connectionString: process.env.BOTSDK_TEST_DATABASE_URL! }),
  keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
  models: {},
  features: [mcp()],
} satisfies BotSdkOptions;

export const disabled = [memory()];
