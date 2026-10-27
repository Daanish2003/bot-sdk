import {
  createTestSdk as createSdk,
  type TestDeps,
  type TestDepsOverrides as SdkOverrides,
} from "@botsdk/testing/test-sdk";
import { memory } from "@botsdk/memory";

import { testModelProviders } from "./model-providers";
import { getTestDb } from "./test-database";

export { testKeyEncryptionSecret, withPart, type TestDeps } from "@botsdk/testing/test-sdk";

/** What a test may override in `createTestSdk`: `@botsdk/testing`'s overrides, and Memory. */
export type TestDepsOverrides = SdkOverrides & {
  /** Whether the Memory feature is on; `true` by default, and only with a `computer`. */
  memory?: boolean;
};

/**
 * `@botsdk/testing`'s test SDK as this repo's tests use it: over the test database, with the
 * curated Providers, and with the Memory feature when there is a `computer`.
 */
export function createTestSdk({
  memory: memoryOn,
  features,
  ...overrides
}: TestDepsOverrides = {}): TestDeps {
  // Memory keeps its files on the Computer, so it needs one.
  const withMemory = memoryOn !== false && overrides.computer !== undefined;
  return createSdk({
    ...overrides,
    db: overrides.db ?? getTestDb(),
    providers: overrides.providers ?? testModelProviders,
    features: [...(withMemory ? [memory()] : []), ...(features ?? [])],
  });
}
