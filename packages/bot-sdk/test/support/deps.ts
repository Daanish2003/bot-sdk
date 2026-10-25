import type { AnyTextAdapter } from "@tanstack/ai";

import { getTestDb } from "./test-database";

import { postgresBlobStore } from "../../core/server/blob/postgres";
import { createMemoryCounters } from "../../core/server/chat/counters";
import { createHookEmitter, type HookEmitter } from "../../core/server/chat/hooks";
import { createMemoryPubSub } from "../../core/server/chat/pubsub";
import type { FeatureEntry, GivenContext } from "../../core/server/create-chat";
import type { BotSdkPlugin } from "../../core/server/plugin";
import { createBotSdkOver, type SdkOver } from "../../core/server/over";
import { memory } from "../../plugins/memory/server/feature";
import type { ComputerProvider } from "../../plugins/computer/server/provider";
import type { ModelsDeps } from "../../plugins/models/server/types";
import type { JobRunner } from "../../plugins/runner/server/jobs/runner";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { fakeReviewer, withReviewer } from "./fake-reviewer";

/** The `test` value of `KEY_ENCRYPTION_SECRET` in `apps/web/.env.schema`. */
export const testKeyEncryptionSecret = "test-key-encryption-secret-not-for-production";

/** What the tests run on: the core context of a test instance, with its `models` plugin's bundle. */
export type TestDeps = SdkOver;

/** What a test may override in `createTestSdk`: a part of the core context or of `models`. */
export type TestDepsOverrides = Partial<
  Omit<GivenContext, "events" | "keyring"> &
    Omit<ModelsDeps, "hooks"> & {
      /** The core's event emitter (`BotSdkContext.events`). */
      hooks: HookEmitter;
      /** The runner slot's jobs runner. */
      jobs: JobRunner;
      /** The computer slot's provider (`fakeComputerProvider().provider`); no Computer by default. */
      computer: ComputerProvider;
      /** More plugins, enabled after `models`. */
      plugins: readonly BotSdkPlugin[];
      /** The features, as the `features` slot takes them. */
      features: readonly FeatureEntry[];
      /** Whether the Memory feature is on; `true` by default, and only with a `computer`. */
      memory: boolean;
      /**
       * The adapter a Bot's Auto-review calls on `model` go to, in place of `adapterFor`'s: by
       * default a fake reviewer that passes every call.
       */
      reviewAdapterFor: (model: string) => AnyTextAdapter;
    }
>;

/** The default reviewer of `createTestSdk`: every call passes. */
const passingReviewer = fakeReviewer().adapter;

/**
 * A real `createBotSdk` instance for tests, over the test database and fakes, with nothing that
 * reaches the network; it returns the instance's core context with its `models` bundle. It is
 * Bot-only: `models`, the runner, the given `computer`, the Memory feature (with a `computer`) and
 * the given `plugins` and `features`. Pass overrides for the parts a
 * test scripts (for example `adapterFor` returning a fake adapter).
 */
export function createTestSdk({
  plugins,
  features,
  computer,
  ...overrides
}: TestDepsOverrides = {}): TestDeps {
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
  const context: GivenContext = {
    db,
    blobStore: overrides.blobStore ?? postgresBlobStore(db),
    runtime: { ...overrides.runtime, pubsub, counters },
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
    // A Bot's Auto-review calls go to the fake reviewer, so a test's scripted rounds are the Bot's.
    adapterFor: withReviewer(
      overrides.adapterFor ??
        ((model) => {
          throw new Error(`No fake adapter for model "${model}"; pass adapterFor to createTestSdk`);
        }),
      overrides.reviewAdapterFor ?? (() => passingReviewer),
    ),
    imageAdapterFor:
      overrides.imageAdapterFor ??
      ((model) => {
        throw new Error(
          `No fake image adapter for model "${model}"; pass imageAdapterFor to createTestSdk`,
        );
      }),
    hostProviders: overrides.hostProviders ?? [],
    hostTools: overrides.hostTools ?? [],
    byok: overrides.byok ?? true,
    linkedCredentials: overrides.linkedCredentials,
    defaultImageModel: overrides.defaultImageModel ?? null,
    recentModelSources: [],
    getQuota: overrides.getQuota ?? (async () => null),
  };
  // Memory keeps its files on the Computer, so it needs one.
  const withMemory = overrides.memory !== false && computer !== undefined;
  return createBotSdkOver(
    {
      context,
      models,
      jobs: overrides.jobs,
      computer,
      plugins,
      features: [...(withMemory ? [memory()] : []), ...(features ?? [])],
    },
    { basePath: "/api/chat", getUser: () => null, logger: { error: () => {} } },
  ).sdk;
}
