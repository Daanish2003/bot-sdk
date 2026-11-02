import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { expect } from "vitest";

import type { TestDeps } from "./deps";

/*
 * The test Customer (spec #1167): the one way a Representative Turn starts until a later spec lets
 * real Customers in. It lives in this private package, which no Host can install. The feature
 * exports nothing to start a Turn and no route or RPC reaches one; only server code holding the
 * runner could queue the job, by name, as it could any job's.
 */

const turnJobName = "representative.turn";

export type TestCustomerTurn = {
  representativeId: string;
  /** What the stand-in Customer says. */
  message: string;
  /** Who the stand-in Customer is; a new one by default. */
  customerId?: string;
};

/** Queues a Representative Turn for a stand-in Customer, without waiting for it. */
export async function startTestCustomerTurn(
  deps: Pick<TestDeps, "runner">,
  { representativeId, message, customerId = uuidv7() }: TestCustomerTurn,
) {
  const payload = { representativeId, customerId, message };
  return { customerId, jobId: await deps.runner.enqueue(turnJobName, payload) };
}

/** Runs a Representative Turn for a stand-in Customer until its job ends, on a started runner. A failed job fails the test. */
export async function testCustomerTurn(deps: Pick<TestDeps, "runner">, turn: TestCustomerTurn) {
  const started = await startTestCustomerTurn(deps, turn);
  await expect
    .poll(async () => (await deps.runner.status(started.jobId))?.status, { timeout: 20_000 })
    .toMatch(/^(succeeded|failed|cancelled)$/);
  const ended = await deps.runner.status(started.jobId);
  expect(ended?.status, ended?.lastError ?? undefined).toBe("succeeded");
  return started;
}
