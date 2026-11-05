import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { answers, promoteAutoTopic, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";

import {
  type CustomerChannel,
  noCustomerChannel,
  noProofAnswer,
} from "../src/server/customer-proof";
import {
  representative,
  representativeOutboundDecision,
  representativeThreadMessage,
  representativeVerification,
} from "../src/server/db/schema";
import { inboundLimit } from "../src/server/inbound-limit";
import { heldAccountChannel } from "../src/server/channel-accounts";
import { representativeFeature } from "../src/server/plugin";
import { holdingNote } from "../src/server/reply-drafts";
import { unavailableNotice } from "../src/server/unavailable-notice";
import { withWebChat } from "../src/server/web-chat";
import type { WebChatMessage } from "../src/shared/contract";

/*
 * A web chat visitor sends and reads over the public routes (ticket #1336): real HTTP requests, shaped
 * as a browser sends them across origins with no preflight, over a Node server with a fake Model, on
 * real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const basePath = "/api/chat";
const shop = "https://shop.example";
const model = "openai:gpt-6-luna";
const poll = { timeout: 10_000 };
const cookie = "session=the-owner";

const servers: Server[] = [];
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A served instance whose Host signs in whoever brings `cookie`, with an owner and an enabled Representative. */
async function world(
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"] = [],
  channel: CustomerChannel = noCustomerChannel,
) {
  const timer = fakeJobClock(new Date("2026-11-05T12:00:00Z"));
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representativeFeature({}, channel)],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  const user = await insertUser();
  const server = createServer(
    toNodeHandler(
      createHttpHandlerOver(deps, {
        basePath,
        getUser: (request) => (request.headers.get("cookie") === cookie ? user : null),
      }),
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;

  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "verify_customer"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  await rpc.representative.widgetKeyCreate({ id });
  const { key } = await rpc.representative.widgetKeySetOrigins({ id, origins: [shop] });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/representative/widget/${path}`, {
      method: "POST",
      // What `fetch` sets for a string body: the type that needs no preflight.
      headers: { origin: shop, "content-type": "text/plain;charset=UTF-8", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const startSession = async () => {
    const response = await fetch(`${url}/representative/widget/${key}/session`, {
      method: "POST",
      headers: { origin: shop },
    });
    return ((await response.json()) as { token: string }).token;
  };
  const send = async (token: string, text: string) => {
    const response = await post("send", { token, text });
    expect(response.status).toBe(202);
  };
  const read = async (token: string) => {
    const response = await post("read", { token });
    expect(response.status).toBe(200);
    return ((await response.json()) as { messages: WebChatMessage[] }).messages;
  };
  /** Moves the clock past the batch, which is what makes a Turn due. */
  const dueTurn = () => {
    timer.advance(batchLongestMs);
    timer.tick();
  };
  const said = async (token: string) => (await read(token)).map(({ from, text }) => [from, text]);
  const threadOf = async (index = 0) => (await rpc.representative.threadList({ id }))[index]!;
  return {
    threadOf,
    deps,
    fake,
    user,
    rpc,
    id,
    key,
    url,
    timer,
    post,
    startSession,
    send,
    read,
    said,
    dueTurn,
  };
}

describe("a visitor with a session token", () => {
  it("sends, has a Turn answer, and reads the reply", async () => {
    const { startSession, send, said, dueTurn } = await world([answers(), round()]);
    const token = await startSession();

    await send(token, "Are you open today?");
    dueTurn();

    await expect
      .poll(() => said(token), poll)
      .toEqual([
        ["customer", "Are you open today?"],
        ["business", "Noted."],
      ]);
  });

  it("reads the same thread again, with a message sent while they were away", async () => {
    const { startSession, send, read, dueTurn, rpc, threadOf, id } = await world([
      answers(),
      round(),
    ]);
    const token = await startSession();
    await send(token, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    const before = await read(token);

    const thread = await threadOf();
    await rpc.representative.threadTakeOver({ id: thread.id });
    await rpc.representative.threadSend({ id: thread.id, text: "We found your order." });

    const after = await read(token);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ from: "business", text: "We found your order." });

    await send(token, "Thanks");
    expect((await read(token)).at(-1)).toMatchObject({ from: "customer", text: "Thanks" });
    expect(await rpc.representative.threadList({ id })).toHaveLength(1);
  });

  it("is told their session has ended, in an answer their page can read", async () => {
    const { startSession, post, rpc, id } = await world();
    const token = await startSession();
    await rpc.representative.widgetKeyDisable({ id });

    for (const response of [
      await post("read", { token }),
      await post("send", { token, text: "Hello" }),
      await post("read", { token: "not.a.real.token" }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({ code: "error.widgetSessionEnded", params: {} });
    }
  });

  it("can't send what isn't one message of text", async () => {
    const { startSession, post } = await world();
    const token = await startSession();

    for (const body of [
      "not json",
      "",
      { token },
      { token, text: "   " },
      { token, text: "x".repeat(60_001) },
      "x".repeat(400_000),
    ]) {
      const response = await post("send", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "error.widgetMessageInvalid", params: {} });
    }
  });
});

describe("what a visitor reads", () => {
  it("holds nothing of another session", async () => {
    const { startSession, send, read, said, dueTurn } = await world([answers(), round()]);
    const first = await startSession();
    await send(first, "My door code is 4471");
    dueTurn();
    await expect.poll(async () => (await read(first)).length, poll).toBe(2);

    const second = await startSession();
    expect(await read(second)).toEqual([]);
    await send(second, "Hi");
    expect(await said(second)).toEqual([["customer", "Hi"]]);
    expect((await said(first)).flat()).not.toContain("Hi");
  });

  it("holds nothing of another session on the same Customer, after the owner merges them", async () => {
    const { startSession, send, said, rpc } = await world();
    const first = await startSession();
    await send(first, "First visitor's words");
    const second = await startSession();
    await send(second, "Second visitor's words");
    const [one, two] = await rpc.representative.customerList();

    await rpc.representative.customerMerge({ id: one!.id, intoId: two!.id });

    expect(await said(first)).toEqual([["customer", "First visitor's words"]]);
    expect(await said(second)).toEqual([["customer", "Second visitor's words"]]);
  });

  it("stays in order when a merge moves the session on to an older open thread", async () => {
    const { startSession, send, said, rpc } = await world();
    const older = await startSession();
    await send(older, "The older thread");
    const visitor = await startSession();
    await send(visitor, "Before the merge");
    const customers = await rpc.representative.customerList();
    const identity = visitor.split(".")[1];
    const mine = customers.find(({ identities }) =>
      identities.some(({ externalId }) => externalId === identity),
    )!;
    const other = customers.find(({ id }) => id !== mine.id)!;

    await rpc.representative.customerMerge({ id: mine.id, intoId: other.id });
    await send(visitor, "After the merge");

    expect(await said(visitor)).toEqual([
      ["customer", "Before the merge"],
      ["customer", "After the merge"],
    ]);
  });

  it("holds a Reply draft only once the owner has approved it", async () => {
    const draft = "We can do that soon.";
    const { startSession, send, said, dueTurn, rpc } = await world([
      round(
        toolCall({
          name: "reply",
          input: { topic: "pricing", text: draft, kind: "small_talk" },
        }),
      ),
      round(),
    ]);
    const token = await startSession();
    await send(token, "What would it cost?");
    dueTurn();

    await expect.poll(async () => (await rpc.representative.replyDraftList()).length, poll).toBe(1);
    await expect
      .poll(() => said(token), poll)
      .toEqual([
        ["customer", "What would it cost?"],
        ["business", holdingNote],
      ]);

    const [waiting] = await rpc.representative.replyDraftList();
    await rpc.representative.replyDraftApprove({ id: waiting!.id });
    expect((await said(token)).at(-1)).toEqual(["business", draft]);
  });

  it("doesn't hold what a cap held", async () => {
    const { startSession, send, said, dueTurn, id } = await world([answers(), round()]);
    await getTestDb().update(representative).set({ maxInARow: 0 }).where(eq(representative.id, id));
    const token = await startSession();
    await send(token, "Hello");
    dueTurn();

    await expect
      .poll(async () => {
        const decisions = await getTestDb()
          .select({ id: representativeOutboundDecision.id })
          .from(representativeOutboundDecision)
          .where(
            and(
              eq(representativeOutboundDecision.kind, "reply"),
              eq(representativeOutboundDecision.outcome, "hold"),
            ),
          );
        return decisions.length;
      }, poll)
      .toBe(1);
    expect((await said(token)).flat()).not.toContain("Noted.");
  });

  it("doesn't hold a Bot's result, which only a Turn tells", async () => {
    const { startSession, send, said, threadOf } = await world();
    const token = await startSession();
    await send(token, "Hello");
    const thread = await threadOf();
    const [mine] = await getTestDb()
      .select()
      .from(representativeThreadMessage)
      .where(eq(representativeThreadMessage.threadId, thread.id));

    await getTestDb().insert(representativeThreadMessage).values({
      id: uuidv7(),
      threadId: thread.id,
      position: 50,
      author: "bot",
      text: "Internal: the Bot's working result",
      channel: mine!.channel,
      externalId: mine!.externalId,
      verified: false,
    });

    expect(await said(token)).toEqual([["customer", "Hello"]]);
  });

  it("doesn't hold what the gate passed and delivery then stopped", async () => {
    const { startSession, send, read, said, dueTurn } = await world([answers(), round()]);
    const token = await startSession();
    await send(token, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    const [passed] = await getTestDb()
      .select()
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.kind, "reply"));

    // As the delivery job logs it, for a Customer blocked since the gate passed the message.
    await getTestDb()
      .insert(representativeOutboundDecision)
      .values({ ...passed!, id: uuidv7(), outcome: "drop", rule: "blocked" });

    expect(await said(token)).toEqual([["customer", "Hello"]]);
  });

  it("holds nothing but who said it and what they said", async () => {
    const { startSession, send, read, dueTurn } = await world([answers(), round()]);
    const token = await startSession();
    await send(token, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);

    for (const message of await read(token)) {
      expect(Object.keys(message).sort()).toEqual(["from", "id", "text"]);
    }
  });
});

describe("a visitor over the inbound limit", () => {
  it("is told, rather than told it was accepted", async () => {
    const { startSession, post, said } = await world();
    const token = await startSession();
    for (let sent = 0; sent < inboundLimit; sent += 1) {
      expect((await post("send", { token, text: `Message ${sent}` })).status).toBe(202);
    }

    const over = await post("send", { token, text: "One too many" });

    expect(over.status).toBe(429);
    expect(over.headers.get("access-control-allow-origin")).toBe("*");
    expect(await over.json()).toEqual({ code: "error.tooManyRequests", params: {} });
    expect((await said(token)).flat()).not.toContain("One too many");
  });
});

describe("a signed-in owner's cookie", () => {
  it("gives no extra power on these routes", async () => {
    const { startSession, send, said, post, read } = await world();
    const visitor = await startSession();
    await send(visitor, "Private words");
    const withCookie = { cookie };

    for (const body of [{ token: "" }, { token: "not.a.real.token" }]) {
      const reading = await post("read", body, withCookie);
      expect(reading.status).toBe(401);
      const sending = await post("send", { ...body, text: "From the owner" }, withCookie);
      expect(sending.status).toBe(401);
    }

    const another = await startSession();
    const reading = await post("read", { token: another }, withCookie);
    expect(await reading.json()).toEqual({ messages: [] });
    expect(reading.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await read(another)).toEqual([]);
    expect(await said(visitor)).toEqual([["customer", "Private words"]]);
  });
});

describe("a Customer-supplied image ref", () => {
  const ref = "file:0199aaaa-the-other-customers-blob";

  it("doesn't reach a model call", async () => {
    const { startSession, post, send, dueTurn, read, fake } = await world([answers(), round()]);
    const token = await startSession();

    const image = { type: "image", source: { type: "url", value: ref, mimeType: "image/png" } };
    for (const body of [
      { token, text: "Look at this", image },
      { token, text: "Look at this", content: [image] },
    ]) {
      expect((await post("send", body)).status).toBe(400);
    }
    expect(await read(token)).toEqual([]);

    await send(token, "Look at this");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    const called = JSON.stringify(fake.calls[0]!.messages);
    expect(called).not.toContain(ref);
    expect(called).not.toContain('"type":"image"');
  });

  it("stays text when a visitor types one", async () => {
    const { startSession, send, dueTurn, read, fake } = await world([answers(), round()]);
    const token = await startSession();

    await send(token, ref);
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    expect(JSON.stringify(fake.calls[0]!.messages)).not.toContain('"type":"image"');
  });
});

describe("a switched-off Representative", () => {
  it("has its fixed notice reach the visitor, with no model call", async () => {
    const { startSession, send, said, dueTurn, rpc, id, fake } = await world();
    await rpc.representative.setEnabled({ id, enabled: false });
    const token = await startSession();

    await send(token, "Hello");
    dueTurn();

    await expect
      .poll(() => said(token), poll)
      .toEqual([
        ["customer", "Hello"],
        ["business", unavailableNotice],
      ]);
    expect(fake.calls).toEqual([]);
  });
});

describe("an unverified session", () => {
  it("isn't offered a code, sends none, and still gets an answer", async () => {
    const proofs: unknown[] = [];
    const { startSession, send, read, said, dueTurn, fake } = await world(
      [
        round(
          toolCall({
            name: "verify_customer",
            input: { channel: "email", externalId: "ada@example.com" },
          }),
        ),
        answers(),
        round(),
      ],
      {
        send: async () => {},
        sendProof: async (to, proof) => {
          proofs.push({ to, proof });
        },
      },
    );
    const token = await startSession();

    await send(token, "I'm Ada, email me a code");
    dueTurn();

    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    expect((await said(token)).at(-1)).toEqual(["business", "Noted."]);
    expect(JSON.stringify(fake.calls[1]!.messages)).toContain(noProofAnswer.answer);
    expect(proofs).toEqual([]);
  });
});

describe("a web chat identity", () => {
  it("is no address for a proof, since no code can reach it", async () => {
    let claim = "";
    const script = (options: { messages: unknown }) => {
      const messages = options.messages as Array<{ role: string }>;
      const asked = JSON.stringify(messages).includes("send it there");
      const tools = messages.filter(({ role }) => role === "tool").length;
      if (asked && tools === 0) {
        return round(
          toolCall({ name: "verify_customer", input: { channel: "web", externalId: claim } }),
        );
      }
      return messages.at(-1)?.role === "tool" && !asked ? round() : tools > 1 ? round() : answers();
    };
    const { deps, startSession, send, id, timer } = await world(Array(8).fill(script));
    const token = await startSession();
    claim = token.split(".")[1]!;
    await send(token, "Hello");

    await testCustomerTurn(Object.assign(deps, { timer }), {
      representativeId: id,
      channel: "sms",
      externalId: "+15550001",
      proof: { rule: "sameIdentity" },
      message: "That web chat is me, so send it there",
    });

    const [made] = await getTestDb().select().from(representativeVerification);
    expect(made!.targetIdentityId).toBe(made!.senderIdentityId);
  });
});

describe("web chat as a Channel", () => {
  it("declares that it can't start a conversation, and leaves every other Channel's limits alone", () => {
    const reach = { replyWindowHours: 24 };
    const channel = withWebChat({ ...noCustomerChannel, reach: () => reach });
    expect(channel.reach!("web")).toEqual({ canStartConversation: false });
    expect(channel.reach!("sms")).toBe(reach);
  });

  it("sends nothing out, since the visitor reads the thread", async () => {
    const via = { representativeId: "r", channelAccountId: "c", resume: null };
    const sent: unknown[] = [];
    const channel = withWebChat({
      ...noCustomerChannel,
      send: async (to, _message, how) => {
        sent.push([to.channel, how]);
      },
    });
    await channel.send({ channel: "web", externalId: "a" }, { text: "Hi" }, via);
    await channel.send({ channel: "sms", externalId: "b" }, { text: "Hi" }, via);
    expect(sent).toEqual([["sms", via]]);
  });

  it("logs nothing for a web chat message, though no adapter serves it", async () => {
    const error = vi.fn();
    const channel = withWebChat(
      heldAccountChannel({
        db: getTestDb(),
        channelAccounts: { reach: () => undefined } as never,
        logger: { error } as never,
      }),
    );
    const via = { representativeId: "r", channelAccountId: null, resume: null };
    await channel.send({ channel: "web", externalId: "a" }, { text: "Hi" }, via);
    expect(error).not.toHaveBeenCalled();
    await channel.send({ channel: "sms", externalId: "b" }, { text: "Hi" }, via);
    expect(error).toHaveBeenCalledOnce();
  });
});
