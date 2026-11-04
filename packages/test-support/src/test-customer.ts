import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { claimJob, type inProcessRunner } from "@botsdk/bot/runner/internal";
import { expect } from "vitest";

// By path, on purpose: the feature's package exports no way to start a Turn, and a test holds it to that.
import { customerDeliveryJobName } from "../../botsdk/representative/src/server/outbound-gate";
import { receiveCustomerMessage } from "../../botsdk/representative/src/server/thread-turns";

import type { TestDeps } from "./deps";
import { getTestDb } from "./test-database";

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
  /** What the Channel's Customer path says of this sender, by its rule; a Channel with no rule by default. */
  proof?:
    | { rule: "sameIdentity" }
    | { rule: "codeRoundTrip" }
    | { rule: "codeToRecord" }
    | { rule: "dmarc"; pass: boolean; policy: "none" | "quarantine" | "reject" };
};

/**
 * Claims the next job for a test that claims jobs by hand, having run each Customer delivery due
 * before it: a test scripting Turns isn't scripting what the gate sends between them.
 */
export async function claimPastDeliveries(
  jobs: Pick<ReturnType<typeof inProcessRunner>, "runClaimed">,
  now: Date,
  options: Parameters<typeof claimJob>[2],
) {
  for (;;) {
    const claimed = await claimJob(getTestDb(), now, options);
    if (claimed?.name !== customerDeliveryJobName) return claimed;
    await jobs.runClaimed(claimed, {});
  }
}

/** Sends a stand-in Customer's message: its job, null when no Turn follows, as for a blocked Customer. */
async function sendTestCustomerMessage(
  deps: Pick<TestDeps, "parts">,
  {
    representativeId,
    message,
    channel = fakeChannel,
    externalId = uuidv7(),
    proof,
  }: TestCustomerTurn,
) {
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative");
  if (!feature) throw new Error("This test SDK has no representative feature");
  const received = await receiveCustomerMessage(feature.context, {
    representativeId,
    channel,
    externalId,
    proof,
    message,
  });
  if (!received) throw new Error(`No Representative ${representativeId}`);
  return { channel, externalId, jobId: received.jobId };
}

/**
 * Sends a stand-in Customer's message, without waiting for its Turn: `jobId` is that of the Turn
 * holding the thread. A later message that batches with it replaces that job, and one sent during a
 * Turn that has begun is answered by a later job. It throws when no Turn follows: on a blocked
 * Customer, or on a Representative that doesn't exist, having made nothing.
 */
export async function startTestCustomerTurn(deps: Pick<TestDeps, "parts">, turn: TestCustomerTurn) {
  const { jobId, ...sent } = await sendTestCustomerMessage(deps, turn);
  if (jobId === null) throw new Error("No Turn follows this message");
  return { ...sent, jobId };
}

/**
 * Runs a Representative Turn for a stand-in Customer until its job ends, on a started runner, or
 * just sends the message when no Turn follows. A failed job fails the test. On a runner with a fake
 * clock, `timer` moves it past the batch's window, which is what makes the Turn due.
 */
export async function testCustomerTurn(
  deps: Pick<TestDeps, "parts" | "runner"> & {
    timer?: { advance(ms: number): void; tick(): void };
  },
  turn: TestCustomerTurn,
) {
  const sent = await sendTestCustomerMessage(deps, turn);
  if (sent.jobId === null) return sent;
  deps.timer?.advance(batchLongestMs);
  deps.timer?.tick();
  const started = { ...sent, jobId: sent.jobId };
  await expect
    .poll(async () => (await deps.runner.status(started.jobId))?.status, { timeout: 20_000 })
    .toMatch(/^(succeeded|failed|cancelled)$/);
  const ended = await deps.runner.status(started.jobId);
  expect(ended?.status, ended?.lastError ?? undefined).toBe("succeeded");
  return started;
}
