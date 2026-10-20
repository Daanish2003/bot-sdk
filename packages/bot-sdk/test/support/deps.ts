import { getTestDb } from "./test-database";

import type { AssistantState } from "../../plugins/assistant/server/state";
import { postgresBlobStore } from "../../core/server/blob/postgres";
import { createMemoryCounters } from "../../core/server/chat/counters";
import { fakeEmbeddingAdapter } from "../../plugins/models/server/fake-embedding-adapter";
import { createHookEmitter, type HookEmitter } from "../../core/server/chat/hooks";
import { createMemoryPubSub } from "../../core/server/chat/pubsub";
import { createMemoryRunStreams } from "../../core/server/chat/run-streams";
import type { GivenContext } from "../../core/server/create-chat";
import type { BotSdkPlugin } from "../../core/server/plugin";
import { createBotSdkOver, type SdkOver } from "../../plugins/assistant/server/over";
import type { Limits } from "../../plugins/assistant/server/deps";
import { memory } from "../../plugins/memory/server/plugin";
import type { ModelsDeps } from "../../plugins/models/server/types";
import type { JobRunner } from "../../plugins/runner/server/jobs/runner";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { createFakeSearchClient } from "./fake-search-client";

/** The `test` value of `KEY_ENCRYPTION_SECRET` in `apps/web/.env.schema`. */
export const testKeyEncryptionSecret = "test-key-encryption-secret-not-for-production";

/**
 * What the tests run on: the core context of a test instance, with its `models` plugin's bundle.
 * The `assistant` plugin's state is `assistantState(deps)`.
 */
export type TestDeps = SdkOver;

/** What a test may override in `createTestSdk`: a part of the core context, of `models` or of the assistant. */
export type TestDepsOverrides = Partial<
  Omit<GivenContext, "events" | "keyring"> &
    Omit<ModelsDeps, "hooks"> &
    Omit<AssistantState, "limits"> & {
      /** The core's event emitter (`BotSdkContext.events`). */
      hooks: HookEmitter;
      limits: Partial<Limits>;
      /** The `runner` plugin's jobs runner (`runner({ jobs })`). */
      jobs: JobRunner;
      /** More plugins, enabled after `models` and the assistant. */
      plugins: readonly BotSdkPlugin[];
      /** Whether the `memory` plugin is installed; `true` by default. */
      memory: boolean;
    }
>;

/**
 * A real `createBotSdk` instance for tests, over the test database and fakes, with nothing that
 * reaches the network; it returns the instance's core context with its `models` bundle. Pass
 * overrides for the parts a test scripts (for example `adapterFor` returning a fake adapter).
 */
export function createTestSdk({ limits, plugins, ...overrides }: TestDepsOverrides = {}): TestDeps {
  const db = overrides.db ?? getTestDb();
  // Silent, like the handler's logger in `support/sdk.ts`: the tests assert on rows, not logs.
  const logger = overrides.logger ?? { error: () => {} };
  const events = overrides.hooks ?? createHookEmitter(undefined, { error: () => {} });
  const keyring = overrides.keyEncryptionSecrets ?? [testKeyEncryptionSecret];
  // Ollama's host shares the test fake unless a test gives it one (see `ModelsDeps.ollamaFetch`).
  const fetch: typeof globalThis.fetch =
    overrides.fetch ??
    (async (input) => {
      throw new Error(`Unexpected network call in a test: ${String(input)}`);
    });
  const pubsub = overrides.pubsub ?? overrides.runtime?.pubsub ?? createMemoryPubSub();
  const counters = overrides.counters ?? overrides.runtime?.counters ?? createMemoryCounters();
  const runStreams =
    overrides.runStreams ?? overrides.runtime?.runStreams ?? createMemoryRunStreams();
  const context: GivenContext = {
    db,
    blobStore: overrides.blobStore ?? postgresBlobStore(db),
    runtime: { ...overrides.runtime, runStreams, pubsub, counters },
    pubsub,
    counters,
    logger,
    events,
    fetch,
    fetchAllowHosts: overrides.fetchAllowHosts ?? [],
    clock: overrides.clock ?? (() => new Date()),
    keyring,
    lifecycle: overrides.lifecycle ?? { stopping: false },
    isUserBlocked: overrides.isUserBlocked ?? (async () => false),
    rateLimits: overrides.rateLimits ?? resolveRateLimits(),
  };
  const models: ModelsDeps = {
    db,
    keyEncryptionSecrets: keyring,
    hooks: events,
    logger,
    fetch,
    ollamaFetch: overrides.ollamaFetch ?? fetch,
    adapterFor:
      overrides.adapterFor ??
      ((model) => {
        throw new Error(`No fake adapter for model "${model}"; pass adapterFor to createTestSdk`);
      }),
    imageAdapterFor:
      overrides.imageAdapterFor ??
      ((model) => {
        throw new Error(
          `No fake image adapter for model "${model}"; pass imageAdapterFor to createTestSdk`,
        );
      }),
    embeddingAdapterFor: overrides.embeddingAdapterFor ?? (() => fakeEmbeddingAdapter()),
    transcriptionAdapterFor:
      overrides.transcriptionAdapterFor ??
      ((model) => {
        throw new Error(`No fake transcription adapter for "${model}"; pass one to createTestSdk`);
      }),
    hostProviders: overrides.hostProviders ?? [],
    hostTools: overrides.hostTools ?? [],
    byok: overrides.byok ?? true,
    linkedCredentials: overrides.linkedCredentials,
    defaultBackgroundModel: overrides.defaultBackgroundModel ?? null,
    defaultImageModel: overrides.defaultImageModel ?? null,
    getQuota: overrides.getQuota ?? (async () => null),
  };
  const assistant: Partial<AssistantState> = {
    searchClient: overrides.searchClient ?? createFakeSearchClient(),
    tools: overrides.tools ?? [],
    mcpServers: overrides.mcpServers ?? [],
    artifacts: overrides.artifacts ?? false,
    runStreams,
    runs: overrides.runs ?? new Map(),
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
  };
  const installed = [...(overrides.memory === false ? [] : [memory()]), ...(plugins ?? [])];
  return createBotSdkOver(
    { context, models, assistant, jobs: overrides.jobs, plugins: installed },
    { basePath: "/api/chat", getUser: () => null, logger: { error: () => {} } },
  ).sdk;
}
