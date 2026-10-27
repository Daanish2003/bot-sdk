import { coreContract, createBotSdkClient } from "../src";
import { type AnyContractRouter, isContractProcedure } from "@orpc/contract";
import { type AnyRouter, implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it } from "vitest";

import { channelClient } from "@botsdk/channel-email/client";
import { knowledgeClient } from "@botsdk/knowledge/client";
import { mcpClient } from "@botsdk/mcp/client";
import { memoryClient } from "@botsdk/memory/client";
import { skillsClient } from "@botsdk/skills/client";

/*
 * The browser client is built from contracts alone (spec #873): no server module, not even a type.
 * The test handler implements the same contracts with stubs that answer each call with its path.
 */

const base = "http://localhost/api/chat";
const features = [
  memoryClient(),
  skillsClient(),
  knowledgeClient(),
  mcpClient(),
  channelClient(),
] as const;
const botId = "0190f0c4-6b7a-7c3e-8f00-000000000001";
const sent = {
  id: botId,
  role: "user" as const,
  text: "hi",
  createdAt: new Date("2026-10-26T00:00:00Z"),
};

/** Implements every procedure of `contract` with a stub that answers with its path. */
function stubRouter(contract: AnyContractRouter, path: readonly string[] = []): AnyRouter {
  if (isContractProcedure(contract)) {
    const at = path.join(".");
    return implement(contract).handler(() => (at === "bots.send" ? sent : { at }));
  }
  return Object.fromEntries(
    Object.entries(contract).map(([key, child]) => [key, stubRouter(child, [...path, key])]),
  );
}

function testClient() {
  const contract = {
    ...coreContract,
    ...Object.fromEntries(features.map((feature) => [feature.id, feature.contract])),
  };
  const handler = new RPCHandler(stubRouter(contract));
  return createBotSdkClient({
    baseUrl: base,
    features,
    fetch: async (request) => {
      const { response } = await handler.handle(request, { prefix: "/api/chat/rpc" });
      return response ?? new Response(null, { status: 404 });
    },
  });
}

describe("the client composed from contracts", () => {
  it("calls every core namespace", async () => {
    const { rpc } = testClient();

    expect(await rpc.bots.list()).toEqual({ at: "bots.list" });
    expect(await rpc.bots.send({ botId, id: botId, text: "hi" })).toEqual(sent);
    expect(await rpc.routines.list({ botId })).toEqual({ at: "routines.list" });
    expect(await rpc.checkIns.list({ botId })).toEqual({ at: "checkIns.list" });
    expect(await rpc.helpers.list({ botId })).toEqual({ at: "helpers.list" });
    expect(await rpc.reviews.list({ botId })).toEqual({ at: "reviews.list" });
    expect(await rpc.secrets.list()).toEqual({ at: "secrets.list" });
    expect(await rpc.demonstrations.steps({ demonstrationId: botId })).toEqual({
      at: "demonstrations.steps",
    });
    expect(await rpc.computer.view({ helperId: botId })).toEqual({ at: "computer.view" });
    expect(await rpc.channels.email.address({ botId })).toEqual({
      at: "channels.email.address",
    });
    expect(await rpc.models.list()).toEqual({ at: "models.list" });
    expect(await rpc.models.credentials.list()).toEqual({ at: "models.credentials.list" });
    expect(await rpc.models.readQuota()).toEqual({ at: "models.readQuota" });
  });

  it("calls each feature's namespace under its id", async () => {
    const { rpc } = testClient();

    expect(await rpc.memory.status()).toEqual({ at: "memory.status" });
    expect(await rpc.skills.list({ botId })).toEqual({ at: "skills.list" });
    expect(await rpc.knowledge.list()).toEqual({ at: "knowledge.list" });
    expect(await rpc.mcp.listConnections()).toEqual({ at: "mcp.listConnections" });
  });

  it("lists its features in order, with the core URLs and the features' URLs", () => {
    const client = testClient();

    expect(client.features).toEqual(["memory", "skills", "knowledge", "mcp", "channels"]);
    expect(client).toMatchObject({
      exportUrl: `${base}/export`,
      eventsUrl: `${base}/events`,
      botFilesUrl: `${base}/bot-files`,
      routineWebhookUrl: `${base}/routines/webhook`,
      connectionsUrl: `${base}/mcp`,
    });
  });
});
