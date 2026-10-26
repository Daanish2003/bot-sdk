import type { TestDeps } from "./deps";
import { createBotSdkClient, type BotSdkClient } from "../../core/client/chat-client";
import type { BotSdkClientPlugin } from "../../core/client/plugin";
import { botClient } from "../../plugins/bot/client/index";
import { memoryClient } from "../../plugins/memory/client/index";
import { skillsClient } from "../../plugins/skills/client/index";
import { knowledgeClient } from "../../plugins/knowledge/client/index";
import { channelClient } from "../../plugins/channel/client/index";
import { modelsClient } from "../../plugins/models/client/index";
import type { HttpHandlerOptions } from "../../core/http";
import { createChatHandler } from "../../core/server/over";
import { createTestSdk } from "./deps";
import type { TestUser } from "./users";

const basePath = "/api/chat";

/**
 * The SDK as a test drives it: the headless client whose fetch is the handler, built over the
 * test dependencies. `user` is who `getUser` returns; leave it out for a signed-out caller.
 * `clientPlugins` are added after the Bot-only ones (for example `mcpClient()`), and `rateLimits`
 * are the handler's. Errors are not logged (the test context's logger is silent), since the tests
 * assert on the responses.
 */
export function createTestChat({
  user,
  deps = createTestSdk(),
  clientPlugins = [],
  rateLimits,
}: {
  user?: TestUser | null;
  deps?: TestDeps;
  clientPlugins?: BotSdkClientPlugin[];
  rateLimits?: HttpHandlerOptions["rateLimits"];
} = {}): BotSdkClient {
  const handler = createChatHandler(deps, {
    basePath,
    getUser: () => (user ? { id: user.id } : null),
    rateLimits,
  });
  return createBotSdkClient({
    plugins: [
      modelsClient(),
      memoryClient(),
      skillsClient(),
      knowledgeClient(),
      channelClient(),
      botClient(),
      ...clientPlugins,
    ],
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
