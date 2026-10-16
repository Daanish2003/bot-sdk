import type { AppDeps } from "../../core/server/deps";
import { createBotSdkClient, type BotSdkClient } from "../../core/client/chat-client";
import { createChatHandler } from "../../core/server/create-chat";
import { createTestSdk } from "./deps";
import type { TestUser } from "./users";

const basePath = "/api/chat";

/**
 * The SDK as a test drives it: the headless client whose fetch is the handler, built over the
 * test dependencies. `user` is who `getUser` returns; leave it out for a signed-out caller.
 * Errors are not logged, since the tests assert on the responses.
 */
export function createTestChat({
  user,
  deps = createTestSdk(),
}: { user?: TestUser | null; deps?: AppDeps } = {}): BotSdkClient {
  const handler = createChatHandler(deps, {
    basePath,
    getUser: () => (user ? { id: user.id } : null),
    logger: { error: () => {} },
  });
  return createBotSdkClient({ baseUrl: `http://localhost${basePath}`, fetch: handler });
}

/** The typed RPC client of `createTestChat`, for the procedures. */
export function chatRpc(options: { user?: TestUser | null; deps?: AppDeps } = {}) {
  return createTestChat(options).rpc;
}

/**
 * Sends a raw request (a Run POST or a join GET) to the handler, signed in as `user`. The request
 * must target the handler's paths, for example `http://localhost/api/chat/run`.
 */
export function sendAs(request: Request, user: TestUser, deps: AppDeps): Promise<Response> {
  return createTestChat({ user, deps }).fetch(request);
}
