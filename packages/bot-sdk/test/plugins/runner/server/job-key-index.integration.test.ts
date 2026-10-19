import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getTestDb } from "../../../support/test-database";

describe("job idempotency key prefix index", () => {
  it("serves the Routine's `routine:<id>:%` prefix LIKE", async () => {
    const db = getTestDb();

    const plan = await db.transaction(async (tx) => {
      // The table is empty, so the planner would scan it; switch the scan off to see whether an
      // index could serve the query at all.
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute<{ "QUERY PLAN": string }>(
        sql`explain select id from chat.job where idempotency_key like 'routine:abc:%'`,
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("job_idempotency_key_prefix_idx");
  });
});
