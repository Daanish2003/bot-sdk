import type { TestProject } from "vitest/node";

import { dropWorkerDatabases, prepareTestDatabases } from "./test-database";

// Both integration projects name this file; the copies are made once and dropped once.
let prepared: Promise<void> | undefined;
let dropped: Promise<void> | undefined;

/**
 * Vitest global setup for integration tests: migrations run once per test run, then each worker
 * gets its own copy of the migrated database, so integration files run in parallel.
 */
export default async function setup(project: TestProject) {
  const workers = project.config.maxWorkers || project.vitest.config.maxWorkers;
  prepared ??= prepareTestDatabases(workers);
  await prepared;
  return () => (dropped ??= dropWorkerDatabases());
}
