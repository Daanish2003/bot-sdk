import type { TestProject } from "vitest/node";

import { dropWorkerDatabases, prepareTestDatabases } from "./test-database";

type Run = { prepared: Promise<void>; dropped?: Promise<void> };

// Both integration projects name this file, and Vitest loads it afresh for each, so the run's
// state is kept on `globalThis`, keyed by the Vitest instance: the copies are made and dropped once.
const runs = ((globalThis as { testDatabaseRuns?: WeakMap<object, Run> }).testDatabaseRuns ??=
  new WeakMap());

/**
 * Vitest global setup for integration tests: migrations run once per test run, then each worker
 * gets its own copy of the migrated database, so integration files run in parallel.
 */
export default async function setup(project: TestProject) {
  let run = runs.get(project.vitest);
  if (!run) {
    const workers = project.config.maxWorkers || project.vitest.config.maxWorkers;
    run = { prepared: prepareTestDatabases(workers) };
    runs.set(project.vitest, run);
  }
  await run.prepared;
  const current = run;
  return () => (current.dropped ??= dropWorkerDatabases());
}
