import { createTestChat as createChat } from "@botsdk/testing/test-sdk";
import type { HttpHandlerOptions } from "@botsdk/bot/http";
import { memoryClient } from "@botsdk/memory/client";
import { skillsClient } from "@botsdk/skills/client";
import { knowledgeClient } from "@botsdk/knowledge/client";
import { mcpClient } from "@botsdk/mcp/client";
import { channelClient } from "@botsdk/client";

import { createTestSdk, type TestDeps } from "./deps";
import type { TestUser } from "./users";

/**
 * The SDK as this repo's tests drive it (`@botsdk/testing`'s `createTestChat`), over the test
 * database's instance by default. The client has every feature's client part.
 */
export function createTestChat({
  user,
  deps = createTestSdk(),
  rateLimits,
}: {
  user?: TestUser | null;
  deps?: TestDeps;
  rateLimits?: HttpHandlerOptions["rateLimits"];
} = {}) {
  return createChat({
    deps,
    user,
    rateLimits,
    features: [memoryClient(), skillsClient(), knowledgeClient(), mcpClient(), channelClient()],
  });
}

/** The typed RPC client of `createTestChat`, for the procedures. */
export function chatRpc(options: Parameters<typeof createTestChat>[0] = {}) {
  return createTestChat(options).rpc;
}

/**
 * Sends a raw request (a Run POST or a join GET) to the handler, signed in as `user`. The request
 * must target the handler's paths, for example `http://localhost/api/chat/run`.
 */
export function sendAs(request: Request, user: TestUser, deps: TestDeps): Promise<Response> {
  return createTestChat({ user, deps }).fetch(request);
}
