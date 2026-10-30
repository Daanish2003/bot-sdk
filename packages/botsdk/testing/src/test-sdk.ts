import type { AnyTextAdapter } from "@tanstack/ai";

import { createBotSdkClient, type FeatureClient } from "@botsdk/client";
import { type Database, postgresBlobStore } from "@botsdk/bot/storage";
import { createMemoryCounters } from "@botsdk/bot/chat/counters";
import { createHookEmitter, type HookEmitter } from "@botsdk/bot/chat/hooks";
import { createMemoryPubSub } from "@botsdk/bot/chat/pubsub";
import type { FeatureEntry, GivenContext } from "@botsdk/bot/create-chat";
import type { HttpHandlerOptions } from "@botsdk/bot/http";
import {
  createBotSdkOver,
  createHttpHandlerOver,
  type OverSlots,
  type SdkOver,
} from "@botsdk/bot/over";
import type { BotSdkPlugin } from "@botsdk/bot/plugin";
import type { ComputerProvider } from "@botsdk/bot/computer/internal";
import type { ModelsDeps } from "@botsdk/bot/models/internal";
import type { JobRunner } from "@botsdk/bot/runner/internal";
import { fakeReviewer, withReviewer } from "./fake-reviewer";

/** A key encryption secret for tests (the `test` value of `KEY_ENCRYPTION_SECRET` in `apps/web/.env.schema`). */
export const testKeyEncryptionSecret = "test-key-encryption-secret-not-for-production";

/** What the tests run on: the core context of a test instance, with its `models` plugin's bundle. */
export type TestDeps = SdkOver;

/** What a test may override in `createTestSdk`: a part of the core context or of `models`. */
export type TestDepsOverrides = Partial<
  // The Ban goes through the `users` slot, as a Host's does.
  Omit<GivenContext, "events" | "keyring" | "isUserBlocked"> &
    OverSlots &
    Omit<ModelsDeps, "hooks"> & {
      /** The core's event emitter (`BotSdkContext.events`). */
      hooks: HookEmitter;
      /** The runner slot's jobs runner. */
      jobs: JobRunner;
      /** The computer slot's provider (`fakeComputerProvider().provider`); no Computer by default. */
      computer: ComputerProvider;
      /** The features, as the `features` slot takes them. */
      features: readonly FeatureEntry[];
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
 * A real `createBotSdk` instance for tests, over the given `db` and fakes, with nothing that
 * reaches the network; it returns the instance's core context with its `models` bundle: the Bot
 * core, the runner, and the given `computer`, `channels` and `features`. Pass overrides for the
 * parts a test scripts (for example `adapterFor` returning a fake adapter). No model providers
 * are registered unless `providers` is passed, and `features` defaults to none.
 */
export function createTestSdk({
  db,
  features,
  computer,
  channels,
  appUrl,
  users,
  reviewModel,
  safety,
  liveViewBase,
  ...overrides
}: Omit<TestDepsOverrides, "db"> & { db: Database }): TestDeps {
  // Silent: the tests assert on rows, not logs.
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
  };
  const models: ModelsDeps = {
    db,
    keyEncryptionSecrets: keyring,
    hooks: events,
    logger,
    fetch,
    ollamaFetch: overrides.ollamaFetch ?? fetch,
    providers: overrides.providers ?? {},
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
    // A test's own `imageAdapterFor` serves every Image Model, as a Host's does.
    imageAdapterOverride: overrides.imageAdapterOverride ?? overrides.imageAdapterFor !== undefined,
    hostProviders: overrides.hostProviders ?? [],
    hostTools: overrides.hostTools ?? [],
    byok: overrides.byok ?? true,
    linkedCredentials: overrides.linkedCredentials,
    defaultImageModel: overrides.defaultImageModel ?? null,
    recentModelSources: [],
    getQuota: overrides.getQuota ?? (async () => null),
  };
  return createBotSdkOver(
    {
      context,
      models,
      jobs: overrides.jobs,
      computer,
      channels,
      appUrl,
      users,
      reviewModel,
      safety,
      liveViewBase,
      features: features ?? [],
    },
    { logger: { error: () => {} } },
  ).sdk;
}

/**
 * `deps` with one more of the core's parts after its own, as the core's work across its parts (a
 * Conversation delete's hooks, a user's delete and export) sees it: for the tests of that work.
 */
export function withPart(deps: TestDeps, part: BotSdkPlugin): TestDeps {
  return { ...deps, parts: { ...deps.parts, all: [...deps.parts.all, part] } };
}

const basePath = "/api/chat";

/**
 * The SDK as a test drives it: the headless client whose fetch is the handler, built over `deps`.
 * `user` is who `getUser` returns; leave it out for a signed-out caller. `features` are the
 * client parts the client has, and `rateLimits` are the handler's. Errors are not logged, since
 * the tests assert on the responses.
 */
export function createTestChat<const Features extends readonly FeatureClient[] = []>({
  deps,
  user,
  features,
  rateLimits,
}: {
  deps: TestDeps;
  user?: { id: string } | null;
  features?: Features;
  rateLimits?: HttpHandlerOptions["rateLimits"];
}) {
  const handler = createHttpHandlerOver(deps, {
    basePath,
    getUser: () => (user ? { id: user.id } : null),
    rateLimits,
  });
  return createBotSdkClient({
    features,
    baseUrl: `http://localhost${basePath}`,
    fetch: handler,
  });
}
