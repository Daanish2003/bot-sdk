import type { TestDeps } from "./deps";
import { createBotSdkClient } from "../../core/client/chat-client";
import { memoryClient } from "../../plugins/memory/client/index";
import { skillsClient } from "../../plugins/skills/client/index";
import { knowledgeClient } from "../../plugins/knowledge/client/index";
import { mcpClient } from "../../plugins/mcp/client/index";
import { channelClient } from "../../plugins/channel/client/index";
import type { HttpHandlerOptions } from "../../core/http";
import { createChatHandler } from "../../core/server/over";
import { createTestSdk } from "./deps";
import type { TestUser } from "./users";

const basePath = "/api/chat";

/**
 * The SDK as a test drives it: the headless client whose fetch is the handler, built over the
 * test dependencies. `user` is who `getUser` returns; leave it out for a signed-out caller.
 * The client has every feature's client part, and `rateLimits` are the handler's. Errors are not logged (the test context's logger is silent), since the tests
 * assert on the responses.
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
  const handler = createChatHandler(deps, {
    basePath,
    getUser: () => (user ? { id: user.id } : null),
    rateLimits,
  });
  return createBotSdkClient({
    features: [memoryClient(), skillsClient(), knowledgeClient(), mcpClient(), channelClient()],
    baseUrl: `http://localhost${basePath}`,
    fetch: handler,
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
