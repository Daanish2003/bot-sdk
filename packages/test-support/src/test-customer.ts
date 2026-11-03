import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { expect } from "vitest";

import type { TestDeps } from "./deps";

/*
 * The test Customer (spec #1167): the one way a Representative Turn starts until a later spec lets
 * real Customers in. It sends as a Customer does (#1249), from an identity on a fake Channel, and the
 * Turn finds or makes the Customer and its thread from that. It lives in this private package, which no Host can install. The feature
 * exports nothing to start a Turn and no route or RPC reaches one; only server code holding the
 * runner could queue the job, by name, as it could any job's.
 */

const turnJobName = "representative.turn";

/** The Channel a test Customer writes from by default. Nothing it sends reaches anything real. */
export const fakeChannel = "fake";

export type TestCustomerTurn = {
  representativeId: string;
  /** What the stand-in Customer says. */
  message: string;
  /** The Channel it writes from; the fake one by default. */
  channel?: string;
  /** Who it is on that Channel; a new identity, so a new Customer, by default. */
  externalId?: string;
};

/** Queues a Representative Turn for a stand-in Customer, without waiting for it. */
export async function startTestCustomerTurn(
  deps: Pick<TestDeps, "runner">,
  { representativeId, message, channel = fakeChannel, externalId = uuidv7() }: TestCustomerTurn,
) {
  const payload = { representativeId, channel, externalId, message };
  return { channel, externalId, jobId: await deps.runner.enqueue(turnJobName, payload) };
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
