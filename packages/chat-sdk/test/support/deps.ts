import { getTestDb } from "./test-database";

import { createMemoryCounters } from "../../core/server/chat/counters";
import { createMemoryPubSub } from "../../core/server/chat/pubsub";
import { createMemoryRunStreams } from "../../core/server/chat/run-streams";
import type { AppDeps, Limits } from "../../core/server/deps";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { createFakeSearchClient } from "./fake-search-client";

/** The `test` value of `KEY_ENCRYPTION_SECRET` in `apps/web/.env.schema`. */
export const testKeyEncryptionSecret = "test-key-encryption-secret-not-for-production";

/**
 * `AppDeps` for tests: the test database and fakes, with nothing that reaches the network.
 * Pass overrides for the parts a test scripts (for example `adapterFor` returning a fake adapter).
 */
export function createTestDeps({
  limits,
  ...overrides
}: Partial<Omit<AppDeps, "limits">> & { limits?: Partial<Limits> } = {}): AppDeps {
  // Ollama's host shares the test fake unless a test gives it one (see `AppDeps.ollamaFetch`).
  const fetch: AppDeps["fetch"] =
    overrides.fetch ??
    (async (input) => {
      throw new Error(`Unexpected network call in a test: ${String(input)}`);
    });
  return {
    db: getTestDb(),
    adapterFor: (model) => {
      throw new Error(`No fake adapter for model "${model}"; pass adapterFor to createTestDeps`);
    },
    searchClient: createFakeSearchClient(),
    tools: [],
    runStreams: createMemoryRunStreams(),
    pubsub: createMemoryPubSub(),
    counters: createMemoryCounters(),
    rateLimits: resolveRateLimits(),
    // Overrides merge, so a test that sets one limit keeps the rest.
    limits: {
      snapshotIntervalMs: 20,
      runCapMs: 2_000,
      leaseMs: 30_000,
      reapIntervalMs: 30_000,
      drainMs: 250_000,
      fetchTimeoutMs: 10_000,
      ...limits,
    },
    keyEncryptionSecrets: [testKeyEncryptionSecret],
    hostProviders: [],
    hostTools: [],
    mcpServers: [],
    fetchAllowHosts: [],
    byok: true,
    getQuota: async () => null,
    lifecycle: { stopping: false, runs: new Map() },
    ...overrides,
    fetch,
    ollamaFetch: overrides.ollamaFetch ?? fetch,
  };
}

/** What a test may override in `createTestDeps`: any part of `AppDeps`, and any part of its limits. */
export type TestDepsOverrides = Parameters<typeof createTestDeps>[0];
