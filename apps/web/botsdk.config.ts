/// <reference types="node" />
import { postgres, type BotSdkOptions } from "@botsdk/bot";
import { convertDocument } from "@botsdk/knowledge/convert";
import { mcp } from "@botsdk/mcp";
import { representative, type KnowledgeFiles } from "@botsdk/representative";

import { e2bConfigOf } from "./src/computer";
import { computerFeatures } from "./src/features";
import { mcpServersOf } from "./src/mcp-server";

/**
 * The Bot SDK's config (spec #874): the options of `createBotSdk` that say where the SDK keeps its
 * data and which features it has. `src/services.ts` builds the SDK from it, with its other options;
 * `scripts/migrate.ts` and `botsdk migrate` migrate the features it lists. It reads `process.env`,
 * not Varlock's ENV, so plain Node loads it with only the variables it reads: `DATABASE_URL`,
 * `BETTER_AUTH_URL`, `E2B_*` and `MCP_SERVER_*`.
 */

const databaseUrl = process.env.DATABASE_URL;
// Never pg's defaults (localhost:5432): `botsdk migrate` must not migrate or drop on another database.
if (!databaseUrl) throw new Error("Set DATABASE_URL");

/** Where the Bot SDK's HTTP layer is mounted (src/routes/api/chat/$.ts): its mail's links open under it. */
export const basePath = "/api/chat";

/** The self-hosted E2B the Computers run on, or none: the server builds its Computer from it. */
export const e2b = e2bConfigOf(process.env);

/**
 * The Knowledge files a Representative's owner may pick (ticket #1265): the SDK's own `knowledge`
 * routes, reached when asked since the SDK is built from this config.
 */
const knowledgeOfSdk = async () => {
  const { knowledge } = (await import("./src/services")).sdk;
  if (!("list" in knowledge)) throw new Error("The Knowledge feature is off");
  return knowledge;
};
const knowledgeFiles: KnowledgeFiles = {
  list: async (input) => (await knowledgeOfSdk()).list(input),
  read: async (input) => (await knowledgeOfSdk()).read(input),
};

export default {
  database: postgres({ connectionString: databaseUrl }),
  features: [
    // Memory, Skills and Knowledge need the Computer, so a Host without one lists none of them.
    ...computerFeatures(e2b !== undefined),
    // MCP (ADR 0027): the users' Connections to the Host's MCP servers (`MCP_SERVER_*`).
    mcp({ servers: mcpServersOf(process.env) }),
    // Representatives (spec #1167): restricted agents that speak for the owner, through approved Releases.
    // Their uploads convert with Knowledge's parsers, which need no Computer. Knowledge files can be
    // picked only where Knowledge is on, which needs the Computer.
    representative({
      convertDocument,
      ...(e2b && { knowledgeFiles }),
      // Where the signed link in a proof mail opens (ticket #1348): the API's URL.
      ...(process.env.BETTER_AUTH_URL && {
        linkUrl: `${process.env.BETTER_AUTH_URL.replace(/\/+$/, "")}${basePath}`,
      }),
    }),
  ],
} as const satisfies Pick<BotSdkOptions, "database" | "features">;
