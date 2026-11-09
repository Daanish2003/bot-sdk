import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { noCustomerChannel } from "../src/server/customer-proof";
import {
  representative,
  representativeCall,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";
import { inboundLimit } from "../src/server/inbound-limit";
import { representativeFeature } from "../src/server/plugin";
import { receiveCustomerMessage } from "../src/server/thread-turns";
import { voice } from "../src/server/voice-adapter";

/*
 * Call start (ticket #1382, ADR 0036): what a Voice agent posts when a phone call arrives, over real
 * HTTP on real Postgres, in the shape `apps/livekit-test` sends and reads.
 */

vi.setConfig({ testTimeout: 30_000 });

const key = "key-a-of-at-least-32-characters-long!!";
const basePath = "/api/chat";
const model = "openai:gpt-6-luna";
const caller = "+15550002";
const disclosure = "I'm an automated assistant, and this call may be transcribed.";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A served instance with an owner, whose enabled Representative holds a voice account. */
async function world(number = "+15551234567") {
  const deps = createTestSdk({
    channels: [voice()],
    features: [representativeFeature({})],
    keyEncryptionSecrets: [key],
    memory: false,
  });
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const handler = createHttpHandlerOver(deps, { basePath, getUser: () => null });
  const server = createServer(toNodeHandler(handler));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;

  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  const release = async (draft: Record<string, unknown> = {}) => {
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer questions about air conditioning.", model, ...draft },
    });
    await rpc.representative.approve({ id });
  };
  await release();
  await rpc.representative.setEnabled({ id, enabled: true });
  const connected = await rpc.representative.voiceAccountConnect({
    id,
    number,
    greeting: "Hi, this is Front desk.",
  });
  const accountId = connected.view.accounts[0]!.id;

  const context = {
    ...deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
    channel: noCustomerChannel,
  };
  /** A text from `who`, on SMS, as a known Customer's history comes to be. */
  const texts = (message: string, who = caller) =>
    receiveCustomerMessage(context, {
      representativeId: id,
      channel: "sms",
      externalId: who,
      message,
    });

  const post = (body: unknown, secret: string | null = connected.secret, account = accountId) =>
    fetch(`${url}/representative/voice/${account}/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret !== null && { authorization: `Bearer ${secret}` }),
      },
      body: JSON.stringify(body),
    });
  const start = async (callId = "call-1", who = caller) => {
    const response = await post({ callId, caller: who, called: number });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown> & { decision: string };
  };
  const threadOf = async () => (await rpc.representative.threadList({ id }))[0]!.id;
  const calls = () =>
    getTestDb()
      .select()
      .from(representativeCall)
      .where(eq(representativeCall.channelAccountId, accountId));
  const identityRows = (who = caller) =>
    getTestDb()
      .select({ customerId: representativeCustomerIdentity.customerId })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.userId, user.id),
          eq(representativeCustomerIdentity.channel, "sms"),
          eq(representativeCustomerIdentity.externalId, who),
        ),
      );
  return {
    deps,
    rpc,
    id,
    user,
    accountId,
    secret: connected.secret,
    release,
    texts,
    post,
    start,
    threadOf,
    calls,
    identityRows,
  };
}

describe("the bearer secret", () => {
  it("refuses no secret, a wrong one, and one for another account", async () => {
    const { post, calls, accountId, secret } = await world();
    const body = { callId: "call-1", caller };
    const other = await world("+15557654321");

    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, "not-the-secret")).status).toBe(401);
    expect((await post(body, other.secret, accountId)).status).toBe(401);
    expect((await post(body, secret, "not-a-uuid")).status).toBe(401);
    expect((await post(body, secret, uuidv7())).status).toBe(401);
    expect(await calls()).toEqual([]);
  });

  it("stops the old secret at once when it is regenerated", async () => {
    const { rpc, id, accountId, post, secret } = await world();
    const body = { callId: "call-1", caller };

    const { secret: renewed } = await rpc.representative.voiceAccountRegenerate({
      id,
      channelAccountId: accountId,
    });

    expect((await post(body, secret)).status).toBe(401);
    expect((await post(body, renewed)).status).toBe(200);
  });
});

describe("who is calling", () => {
  it("is the SMS Customer with that number, on their open thread", async () => {
    const { texts, start, identityRows, threadOf, calls } = await world();
    await texts("My AC is broken.");
    const before = await identityRows();
    const thread = await threadOf();

    expect((await start()).decision).toBe("answer");

    expect(await identityRows()).toEqual(before);
    expect((await calls())[0]).toMatchObject({ threadId: thread, status: "in_progress" });
  });

  it("makes a stranger a Customer on the SMS channel, though the Representative has no SMS account", async () => {
    const { start, identityRows, calls, user } = await world();

    expect((await start()).decision).toBe("answer");

    const [identity] = await identityRows();
    expect(identity).toBeDefined();
    const customers = await getTestDb()
      .select()
      .from(representativeCustomer)
      .where(eq(representativeCustomer.userId, user.id));
    expect(customers.map((row) => row.id)).toEqual([identity!.customerId]);
    const [thread] = await getTestDb()
      .select()
      .from(representativeThread)
      .where(eq(representativeThread.id, (await calls())[0]!.threadId));
    expect(thread).toMatchObject({
      customerId: identity!.customerId,
      lastChannel: "sms",
      lastExternalId: caller,
      messageCount: 0,
    });
  });

  it("finds them however the number was written", async () => {
    const { texts, start, identityRows } = await world();
    await texts("Hello");

    await start("call-1", "+1 (555) 0002");

    expect(await identityRows()).toHaveLength(1);
  });

  it("declines a caller with no usable number", async () => {
    const { start, calls } = await world();

    expect(await start("call-1", "")).toEqual({ decision: "decline" });
    expect(await start("call-2", "anonymous")).toEqual({ decision: "decline" });
    expect(await calls()).toEqual([]);
  });
});

describe("declining a Call", () => {
  const declined = async (scene: Awaited<ReturnType<typeof world>>) => {
    expect(await scene.start()).toEqual({ decision: "decline" });
    expect(await scene.calls()).toEqual([]);
  };

  it("declines a blocked Customer", async () => {
    const scene = await world();
    await scene.texts("Hello");
    const [{ customerId }] = (await scene.identityRows()) as [{ customerId: string }];
    await scene.rpc.representative.customerSetBlocked({ id: customerId, blocked: true });

    await declined(scene);
  });

  it("declines a Customer who opted out", async () => {
    const scene = await world();
    await scene.texts("stop");

    await declined(scene);
  });

  it("declines a thread the owner took over", async () => {
    const scene = await world();
    await scene.texts("Hello");
    await scene.rpc.representative.threadTakeOver({ id: await scene.threadOf() });

    await declined(scene);
  });

  it("declines a Representative switched off, and makes no Customer of a stranger", async () => {
    const scene = await world();
    await scene.rpc.representative.setEnabled({ id: scene.id, enabled: false });

    await declined(scene);
    expect(await scene.identityRows()).toEqual([]);
  });

  it("declines a Representative with no Release", async () => {
    const scene = await world();
    await getTestDb()
      .update(representative)
      .set({ liveReleaseId: null })
      .where(eq(representative.id, scene.id));

    await declined(scene);
  });

  it("declines a Customer over the inbound limit, and not one short of it", async () => {
    const scene = await world();
    await scene.texts("Hello");
    const threadId = await scene.threadOf();
    const more = (n: number, from: number) =>
      getTestDb()
        .insert(representativeThreadMessage)
        .values(
          Array.from({ length: n }, (_, index) => ({
            id: uuidv7(),
            threadId,
            position: from + index,
            author: "customer" as const,
            channel: "sms",
            externalId: caller,
            text: "again",
            verified: false,
            createdAt: new Date(),
          })),
        );
    await more(inboundLimit - 2, 1000);
    expect((await scene.start("call-under")).decision).toBe("answer");

    await more(1, 2000);

    expect(await scene.start("call-over")).toEqual({ decision: "decline" });
    expect(await scene.calls()).toHaveLength(1);
  });
});

describe("what the Voice agent is told", () => {
  it("answers with the voice rules, then the Release, facts, topics and the emergency script", async () => {
    const { rpc, id, release, start } = await world();
    await rpc.representative.documentUpload({
      id,
      file: new File(["Filters are changed every spring."], "maintenance.md"),
    });
    await release({
      skills: [{ name: "Booking", text: "Ask for the address first." }],
      emergencyText: "Leave the building and call 911.",
    });
    await rpc.representative.factAdd({
      key: "hours.week",
      type: "text",
      topic: "Hours",
      value: "Monday to Friday, 8am to 6pm",
    });
    const auto = await rpc.representative.topicAdd({ name: "Opening hours" });
    await rpc.representative.topicSetMode({ id: auto.id, mode: "auto" });
    await rpc.representative.topicAdd({ name: "Warranty claims" });

    const answer = await start();

    expect(answer.decision).toBe("answer");
    const instructions = answer.instructions as string;
    const order = [
      "one question at a time",
      "Answer questions about air conditioning.",
      "Ask for the address first.",
      "Filters are changed every spring.",
      "Monday to Friday, 8am to 6pm",
      "Opening hours",
      "Warranty claims",
      "Leave the building and call 911.",
    ].map((part) => instructions.indexOf(part));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // On a Call the Voice agent's own words go out: nothing fills in a `{{key}}`, or calls `reply`.
    expect(instructions).not.toContain("{{hours.week}}");
    expect(instructions).toContain("record_request");
  });

  it("uses the current Release on the next Call, with no redeploy", async () => {
    const { release, start } = await world();
    expect((await start("call-1")).instructions).toContain("air conditioning");

    await release({ jobText: "Answer questions about heat pumps." });

    const { instructions } = await start("call-2");
    expect(instructions).toContain("heat pumps");
    expect(instructions).not.toContain("air conditioning");
  });

  it("leaves out the facts and topics an owner hasn't got", async () => {
    const { start } = await world();

    const { instructions } = await start();

    expect(instructions).not.toContain("Published facts");
    expect(instructions).not.toContain("you may answer on this call");
    expect(instructions).not.toContain("confirm these by text");
  });

  it("greets with the account's greeting and the fixed AI disclosure, and limits the Call to 600 seconds", async () => {
    const { start } = await world();

    const answer = await start();

    expect(answer.greeting).toBe(`Hi, this is Front desk. ${disclosure}`);
    expect(answer.maxSeconds).toBe(600);
  });

  it.each(["known", "verified"] as const)(
    "puts nothing about a %s Customer in what it returns",
    async (standing) => {
      const { rpc, texts, start, identityRows, user } = await world();
      await texts("My gate code is 4471, I'm at 12 Elm Street.");
      const [{ customerId }] = (await identityRows()) as [{ customerId: string }];
      await rpc.representative.customerRename({ id: customerId, name: "Priya Raman" });
      if (standing === "verified") {
        const later = new Date(Date.now() + 60 * 60_000);
        await getTestDb()
          .update(representativeCustomerIdentity)
          .set({ verifiedContactAt: new Date(), provenUntil: later })
          .where(eq(representativeCustomerIdentity.userId, user.id));
      }

      const said = JSON.stringify(await start());

      expect(said).toContain("Answer questions about air conditioning.");
      for (const data of ["Priya", "4471", "Elm Street", caller]) {
        expect(said).not.toContain(data);
      }
    },
  );
});

describe("the Call's row", () => {
  it("records an answered Call on its thread and voice account", async () => {
    const { start, calls, accountId, threadOf } = await world();

    await start();

    const [call] = await calls();
    expect(call).toMatchObject({
      callId: "call-1",
      channelAccountId: accountId,
      threadId: await threadOf(),
      status: "in_progress",
      endedAt: null,
      requests: [],
    });
    expect(call!.startedAt).toBeInstanceOf(Date);
  });

  it("adds no second row for a repeated start, and answers it the same", async () => {
    const { start, calls } = await world();

    const first = await start();
    const again = await start();

    expect(again).toEqual(first);
    expect(await calls()).toHaveLength(1);
  });

  it("is in the owner's export, and goes with the owner's data", async () => {
    const { start, deps, user } = await world();
    await start("call-exported");

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { customers: { threads: { calls: unknown[] }[] }[] };
    };
    expect(exported.representative.customers[0]!.threads[0]!.calls).toMatchObject([
      { callId: "call-exported", status: "in_progress", requests: [] },
    ]);

    await deleteUserData(deps, user.id);

    expect(
      await getTestDb()
        .select()
        .from(representativeCall)
        .where(eq(representativeCall.callId, "call-exported")),
    ).toEqual([]);
  });

  it("keeps one account's call id from another's", async () => {
    const one = await world();
    const two = await world("+15557654321");

    await one.start("shared-id");
    await two.start("shared-id");

    expect(await one.calls()).toHaveLength(1);
    expect(await two.calls()).toHaveLength(1);
  });
});

describe("a bad request", () => {
  it("answers 400 to a body that isn't the contract's, once the secret has passed", async () => {
    const { post, calls } = await world();

    expect((await post({ caller })).status).toBe(400);
    expect((await post({ callId: "", caller })).status).toBe(400);
    expect(await calls()).toEqual([]);
  });
});
