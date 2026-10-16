import { afterAll, beforeEach } from "vitest";

import { closeTestDb, getTestDb, testDatabaseUrl, truncateAllTables } from "./test-database";

// Suites that open their own pool read TEST_DATABASE_URL: point it at this worker's database.
process.env.TEST_DATABASE_URL = testDatabaseUrl;

beforeEach(async () => {
  await truncateAllTables(getTestDb());
});

afterAll(async () => {
  await closeTestDb();
});
