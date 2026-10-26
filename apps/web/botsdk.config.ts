/// <reference types="node" />
import { postgres, type BotSdkOptions } from "@ai-chat/bot-sdk/core/server";
import { mcp } from "@ai-chat/bot-sdk/plugins/mcp/server";

import { e2bConfigOf } from "./src/computer";
import { computerFeatures } from "./src/features";
import { mcpServersOf } from "./src/mcp-server";

/**
 * The Bot SDK's config (spec #874): the options of `createBotSdk` that say where the SDK keeps its
 * data and which features it has. `src/services.ts` builds the SDK from it, with its other options;
 * `scripts/migrate.ts` and `botsdk migrate` migrate the features it lists. It reads `process.env`,
 * not Varlock's ENV, so plain Node loads it with only the variables it reads: `DATABASE_URL`,
 * `E2B_*` and `MCP_SERVER_*`.
 */
export default {
  database: postgres({ connectionString: process.env.DATABASE_URL ?? "" }),
  features: [
    // Memory, Skills and Knowledge need the Computer, so a Host without one lists none of them.
    ...computerFeatures(e2bConfigOf(process.env) !== undefined),
    // MCP (ADR 0027): the users' Connections to the Host's MCP servers (`MCP_SERVER_*`).
    mcp({ servers: mcpServersOf(process.env) }),
  ],
} as const satisfies Pick<BotSdkOptions, "database" | "features">;
