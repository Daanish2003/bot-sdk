import { prepareTestDatabase } from "./test-database";

/** Vitest global setup for integration tests: migrations run once per test run. */
export default async function setup() {
  await prepareTestDatabase();
}
