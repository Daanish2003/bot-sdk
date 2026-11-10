import { and, count, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { job, page } from "@botsdk/bot/storage";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import type { CustomerChannel } from "../src/server/customer-proof";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { declineReason, type DeclineReason } from "../src/server/declines";
import { inboundLimit } from "../src/server/inbound-limit";
import { representativeFeature } from "../src/server/plugin";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * Whether a Customer may be served, asked without storing anything (ticket #1380). The state comes
 * from the paths that make it for real: a message, the keyword, the owner's block and takeover.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const at = new Date("2026-10-22T09:00:00.000Z");
const heard = { channel: "fake", externalId: "+15550002" };

async function instance() {
  const channel: CustomerChannel = { send: async () => {}, sendProof: async () => {} };
  const deps = createTestSdk({
    features: [representativeFeature({}, channel)],
    clock: () => at,
    memory: false,
  });
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const approved = async (name: string) => {
    const { id } = await rpc.representative.create({ name });
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer questions.", model, tools: ["reply"] },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    return id;
  };
  const id = await approved("Front desk");
  const context = {
    ...deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
    channel,
  };
  const arrives = (message: string, representativeId = id, who = heard) =>
    receiveCustomerMessage(context, { representativeId, ...who, message });
  const threadOf = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  // Past whatever the thread already holds.
  let position = 1000;
  return {
    rpc,
    id,
    approved,
    arrives,
    threadOf,
    /** Its answer, having checked that asking left every table as it found it. */
    asked: async (representativeId = id, who = heard) => {
      const before = await everything();
      const reason = await declineReason(getTestDb(), { representativeId, heard: who, now: at });
      expect(await everything()).toEqual(before);
      return reason;
    },
    block: async () => {
      const [identity] = await getTestDb()
        .select({ customerId: representativeCustomerIdentity.customerId })
        .from(representativeCustomerIdentity)
        .where(
          and(
            eq(representativeCustomerIdentity.userId, user.id),
            eq(representativeCustomerIdentity.externalId, heard.externalId),
          ),
        );
      await rpc.representative.customerSetBlocked({ id: identity!.customerId, blocked: true });
    },
    takeOver: async () => rpc.representative.threadTakeOver({ id: await threadOf() }),
    switchOff: () => rpc.representative.setEnabled({ id, enabled: false }),
    /** `n` more messages from `heard` in the last hour. */
    sent: async (n: number) => {
      const threadId = await threadOf();
      await getTestDb()
        .insert(representativeThreadMessage)
        .values(
          Array.from({ length: n }, () => ({
            id: crypto.randomUUID(),
            threadId,
            position: position++,
            author: "customer" as const,
            ...heard,
            text: "again",
            verified: false,
            createdAt: at,
          })),
        );
    },
    withoutRelease: () =>
      getTestDb()
        .update(representative)
        .set({ liveReleaseId: null })
        .where(eq(representative.id, id)),
  };
}

/** Every kind of row a message, its Turn or an emergency would leave. */
const everything = async () => {
  const db = getTestDb();
  const rowsOf = async (query: Promise<{ n: number }[]>) => (await query)[0]!.n;
  return {
    customers: await rowsOf(db.select({ n: count() }).from(representativeCustomer)),
    identities: await rowsOf(db.select({ n: count() }).from(representativeCustomerIdentity)),
    threads: await rowsOf(db.select({ n: count() }).from(representativeThread)),
    messages: await rowsOf(db.select({ n: count() }).from(representativeThreadMessage)),
    decisions: await rowsOf(db.select({ n: count() }).from(representativeOutboundDecision)),
    pages: await rowsOf(db.select({ n: count() }).from(page)),
    jobs: await rowsOf(db.select({ n: count() }).from(job)),
  };
};

describe("declineReason", () => {
  it("serves a Customer it knows on a thread the Representative holds, and a stranger", async () => {
    const world = await instance();
    await world.arrives("Hello");

    expect(await world.asked()).toBeNull();
    expect(await world.asked(world.id, { channel: "fake", externalId: "+15550003" })).toBeNull();
  });

  it("says a blocked Customer is blocked", async () => {
    const world = await instance();
    await world.arrives("Hello");
    await world.block();

    expect(await world.asked()).toBe("blocked");
  });

  it("says an opted-out Customer has opted out, and they're served again once they come back", async () => {
    const world = await instance();
    await world.arrives("Hello");
    await world.arrives("stop");

    expect(await world.asked()).toBe("opted_out");

    await world.arrives("start");
    expect(await world.asked()).toBeNull();
  });

  it("says a Representative switched off is off, for a stranger too", async () => {
    const world = await instance();
    await world.switchOff();

    expect(await world.asked()).toBe("off");
  });

  it("says a Representative with no Release has none", async () => {
    const world = await instance();
    await world.withoutRelease();

    expect(await world.asked()).toBe("no_release");
  });

  it("says a thread the owner took is taken over, and only on that Representative", async () => {
    const world = await instance();
    const other = await world.approved("Back office");
    await world.arrives("Hello");
    await world.takeOver();

    expect(await world.asked()).toBe("taken_over");
    expect(await world.asked(other)).toBeNull();
  });

  it("says a Customer over the inbound limit is over it, one short isn't", async () => {
    const world = await instance();
    await world.arrives("Hello");
    await world.sent(inboundLimit - 2);
    expect(await world.asked()).toBeNull();

    await world.sent(1);

    expect(await world.asked()).toBe("over_limit");
  });

  it("matches an address however it was typed, as a message's sender is matched", async () => {
    const world = await instance();
    await world.arrives("stop", world.id, { channel: "sms", externalId: "+15550002" });

    expect(await world.asked(world.id, { channel: "sms", externalId: "+1 (555) 0002" })).toBe(
      "opted_out",
    );
  });

  it("says off before it says there is no Release", async () => {
    const world = await instance();
    await world.switchOff();
    await world.withoutRelease();

    expect(await world.asked()).toBe("off");
  });

  it("takes the reasons in the order a message meets them: the limit, the block, the opt-out, the owner, then off", async () => {
    const world = await instance();
    await world.arrives("Hello");
    await world.takeOver();
    await world.switchOff();
    expect(await world.asked()).toBe("taken_over");

    await world.arrives("stop");
    expect(await world.asked()).toBe("opted_out");

    await world.block();
    expect(await world.asked()).toBe("blocked");

    await world.sent(inboundLimit - 1);
    expect(await world.asked()).toBe("over_limit");
  });
});

/*
 * `declineReason` states the rules `receiveMessage` applies, which the two keep in different places
 * (ticket #1389). A Customer is in each state by the paths that make it, then asked about, then sends a
 * real message: the check saying no must be a message that starts no Turn, and null one that does.
 *
 * Not covered, since they only apply to a message: STOP and START are kept by the text path whatever the
 * limit says, and an emergency keyword is exempt from it. A Call has neither, so the check doesn't, and
 * this test sends a plain message.
 */
describe("declineReason and the text inbound path", () => {
  type World = Awaited<ReturnType<typeof instance>>;
  const states: [DeclineReason | null, (world: World) => Promise<unknown>][] = [
    [null, async () => {}],
    ["over_limit", (world) => world.sent(inboundLimit - 1)],
    ["blocked", (world) => world.block()],
    ["opted_out", (world) => world.arrives("stop")],
    ["taken_over", (world) => world.takeOver()],
    ["off", (world) => world.switchOff()],
    ["no_release", (world) => world.withoutRelease()],
  ];

  it.each(states)("agrees about a Customer who is %s", async (reason, makeIt) => {
    const world = await instance();
    await world.arrives("Hello");
    await makeIt(world);

    const asked = await world.asked();
    const received = await world.arrives("Is anyone there?");
    // A switched-off Representative, or one with no Release, still has a Turn queued, which finds
    // nobody to answer and says nothing: the Customer is told so instead (`sendUnavailableNotice`).
    const [told] = await getTestDb()
      .select({ n: count() })
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.kind, "unavailable_notice"));
    const served = received?.jobId != null && told!.n === 0;

    expect(asked).toBe(reason);
    expect(served).toBe(asked === null);
  });
});
