import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { expect } from "vitest";

// By path, on purpose: the feature's package exports no way to start a Turn, and a test holds it to that.
import { receiveCustomerMessage } from "../../botsdk/representative/src/server/thread-turns";

import type { TestDeps } from "./deps";

/*
 * The test Customer (spec #1167): the one way a Representative Turn starts until a later spec lets
 * real Customers in. It sends as a Customer does (#1249), from an identity on a fake Channel, which
 * finds or makes the Customer and its thread. It lives in this private package, which no Host can
 * install. The feature's package exports nothing to start a Turn and no route or RPC reaches one.
 */

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

/**
 * Sends a stand-in Customer's message, without waiting for its Turn: `jobId` is that of the Turn
 * holding the thread. A later message that batches with it replaces that job, and one sent during a
 * Turn that has begun is answered by a later job. It throws on a Representative that doesn't exist,
 * having made nothing.
 */
export async function startTestCustomerTurn(
  deps: Pick<TestDeps, "parts">,
  { representativeId, message, channel = fakeChannel, externalId = uuidv7() }: TestCustomerTurn,
) {
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative");
  if (!feature) throw new Error("This test SDK has no representative feature");
  const jobId = await receiveCustomerMessage(feature.context, {
    representativeId,
    channel,
    externalId,
    message,
  });
  if (!jobId) throw new Error(`No Representative ${representativeId}`);
  return { channel, externalId, jobId };
}

/** Runs a Representative Turn for a stand-in Customer until its job ends, on a started runner. A failed job fails the test. */
export async function testCustomerTurn(
  deps: Pick<TestDeps, "parts" | "runner">,
  turn: TestCustomerTurn,
) {
  const started = await startTestCustomerTurn(deps, turn);
  await expect
    .poll(async () => (await deps.runner.status(started.jobId))?.status, { timeout: 20_000 })
    .toMatch(/^(succeeded|failed|cancelled)$/);
  const ended = await deps.runner.status(started.jobId);
  expect(ended?.status, ended?.lastError ?? undefined).toBe("succeeded");
  return started;
}
