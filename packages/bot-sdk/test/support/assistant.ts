import type { BotSdkClient } from "../../core/client/chat-client";
import { assistantClient } from "../../plugins/assistant/client/index";
import type { Limits } from "../../plugins/assistant/server/deps";
import { assistantOver } from "../../plugins/assistant/server/plugin";
import type { AssistantState } from "../../plugins/assistant/server/state";
import { createFakeSearchClient } from "../../plugins/bot/server/fake-search-client";
import * as botOnly from "./deps";
import * as botOnlyChat from "./sdk";
import type { TestUser } from "./users";

/*
 * The assistant's own tests' support: the test SDK of `support/deps` and the client of
 * `support/sdk` with the assistant added as one more plugin. Only the assistant's tests import it.
 */

export { testKeyEncryptionSecret } from "./deps";
export type TestDeps = botOnly.TestDeps;

/** What an assistant test may override: the Bot-only overrides and a part of the assistant's state. */
export type TestDepsOverrides = botOnly.TestDepsOverrides &
  Partial<Omit<AssistantState, "limits" | "runStreams">> & { limits?: Partial<Limits> };

/** The Bot-only test SDK of `support/deps`, with the assistant over the given parts of its state. */
export function createTestSdk({
  searchClient,
  tools,
  artifacts,
  runs,
  limits,
  plugins,
  ...overrides
}: TestDepsOverrides = {}): TestDeps {
  const assistant = assistantOver({
    searchClient: searchClient ?? createFakeSearchClient(),
    tools: tools ?? [],
    artifacts: artifacts ?? false,
    runs: runs ?? new Map(),
    // Overrides merge, so a test that sets one limit keeps the rest.
    limits: {
      snapshotIntervalMs: 20,
      runCapMs: 2_000,
      leaseMs: 30_000,
      reapIntervalMs: 30_000,
      drainMs: 250_000,
      fetchTimeoutMs: 10_000,
      imageTimeoutMs: 120_000,
      ...limits,
    },
  });
  return botOnly.createTestSdk({ ...overrides, plugins: [assistant, ...(plugins ?? [])] });
}

type ChatOptions = { user?: TestUser | null; deps?: TestDeps };

/** `support/sdk`'s client with the assistant's client plugin, over an assistant test SDK by default. */
export function createTestChat({ user, deps = createTestSdk() }: ChatOptions = {}): BotSdkClient {
  return botOnlyChat.createTestChat({ user, deps, clientPlugins: [assistantClient()] });
}

/** The typed RPC client of `createTestChat`, for the procedures. */
export function chatRpc(options: ChatOptions = {}) {
  return createTestChat(options).rpc;
}

/** Sends a raw request (a Run POST or a join GET) to the handler, signed in as `user`. */
export function sendAs(request: Request, user: TestUser, deps: TestDeps): Promise<Response> {
  return createTestChat({ user, deps }).fetch(request);
}
