import { afterAll, beforeEach } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "./test-database";

beforeEach(async () => {
  await truncateAllTables(getTestDb());
});

afterAll(async () => {
  await closeTestDb();
});
