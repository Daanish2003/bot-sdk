import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CounterStore } from "@botsdk/bot/chat/counters";
import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { createMemoryPubSub, type PubSub } from "@botsdk/bot/chat/pubsub";
import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { job } from "@botsdk/bot/storage";
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
import { representativeFeature } from "../src/server/plugin";
import { customerDeliveryJobName } from "../src/server/outbound-gate";
import { holdingNote } from "../src/server/reply-drafts";
import { unavailableNotice } from "../src/server/unavailable-notice";
import { representativeTurnJobName } from "../src/server/thread-turns";
import type { ClientIp } from "../src/server/web-chat-limits";
import {
  maxStreamsPerIp,
  maxStreamsPerSession,
  sessionCheckMs,
  withWebChat,
} from "../src/server/web-chat";
import { widgetSessionLastsMs } from "../src/server/widget-key";
import type { WebChatMessage, WebChatStreamEvent } from "../src/shared/contract";

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
const streams: AbortController[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const stream of streams.splice(0)) stream.abort();
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
  counters?: CounterStore,
  pubsub: PubSub = createMemoryPubSub(),
  clientIp?: ClientIp,
) {
  const timer = fakeJobClock(new Date("2026-11-05T12:00:00Z"));
  const fake = createFakeAdapter({ rounds });
  const ban = { on: false };
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
    features: [representativeFeature({ clientIp }, channel)],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
    pubsub,
    users: { isBlocked: async () => ban.on },
    ...(counters && { counters }),
  });
  await jobs.start();
  runners.push(jobs);
  const user = await insertUser();
  const handler = createHttpHandlerOver(deps, {
    basePath,
    getUser: (request) => (request.headers.get("cookie") === cookie ? user : null),
  });
  const server = createServer(toNodeHandler(handler));
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

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    fetch(`${url}/representative/widget/${path}`, {
      method: "POST",
      signal,
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
  /** Opens the stream as a page does, with `fetch`, reading what it says as it arrives. */
  const openStream = async (token: string) => {
    const stop = new AbortController();
    streams.push(stop);
    const response = await post("stream", { token }, {}, stop.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const events: WebChatStreamEvent[] = [];
    const seen = { raw: "", closed: false };
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body!) {
          const text = decoder.decode(chunk);
          seen.raw += text;
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          }
        }
        seen.closed = true;
      } catch {
        // This test's own abort.
      }
    })();
    return { events, seen, stop: () => stop.abort() };
  };
  const said = async (token: string) => (await read(token)).map(({ from, text }) => [from, text]);
  const threadOf = async (index = 0) => (await rpc.representative.threadList({ id }))[index]!;
  return {
    threadOf,
    ban,
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
    openStream,
    jobs,
    handler,
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
    // Counters that never refuse, so the session limit (ticket #1337) doesn't stand before this one.
    const { startSession, post, said } = await world([], noCustomerChannel, {
      hit: async () => ({ count: 1, resetMs: 1000 }),
    });
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
});

const changed = { type: "changed" };
const ended = { type: "ended", code: "error.widgetSessionEnded" };

/** Waits for a reply's decision to be written, which a hint can only follow. */
const decisionsOf = async (outcome: "send" | "hold") =>
  (
    await getTestDb()
      .select({ id: representativeOutboundDecision.id })
      .from(representativeOutboundDecision)
      .where(
        and(
          eq(representativeOutboundDecision.kind, "reply"),
          eq(representativeOutboundDecision.outcome, outcome),
        ),
      )
  ).length;

/** Waits out the first delivery, so that its own hint can't pass for a later one's. */
const delivered = () =>
  expect
    .poll(async () => {
      const [sent] = await getTestDb()
        .select({ status: job.status })
        .from(job)
        .where(eq(job.name, customerDeliveryJobName));
      return sent?.status;
    }, poll)
    .toBe("succeeded");

/** What a page refused a stream reads, whatever site it is on. */
const tooMany = async (response: Response) => {
  expect(response.status).toBe(429);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-expose-headers")).toBe("Retry-After");
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await response.json()).toEqual({ code: "error.tooManyRequests", params: {} });
};

describe("a visitor's stream", () => {
  it("hints at a sent reply with no words of it, and a re-read returns it", async () => {
    const { startSession, send, said, dueTurn, openStream } = await world([answers(), round()]);
    const token = await startSession();
    const stream = await openStream(token);
    await expect.poll(() => stream.events, poll).toEqual([changed]);

    await send(token, "Are you open today?");
    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    dueTurn();

    await expect.poll(() => stream.events, poll).toEqual([changed, changed, changed]);
    expect(await said(token)).toEqual([
      ["customer", "Are you open today?"],
      ["business", "Noted."],
    ]);
    expect(stream.seen.raw).not.toContain("Noted.");
    expect(stream.seen.raw).not.toContain("Are you open");
  });

  it("gets no hints from another session", async () => {
    const { startSession, send, read, dueTurn, openStream } = await world([answers(), round()]);
    const mine = await openStream(await startSession());
    const other = await startSession();
    const theirs = await openStream(other);
    await expect.poll(() => mine.events, poll).toEqual([changed]);

    await send(other, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(other)).length, poll).toBe(2);
    await expect.poll(() => theirs.events, poll).toEqual([changed, changed, changed]);

    expect(mine.events).toEqual([changed]);
  });

  describe("is refused", () => {
    const refused = async (post: Awaited<ReturnType<typeof world>>["post"], token: string) => {
      const response = await post("stream", { token });
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({ code: "error.widgetSessionEnded", params: {} });
    };

    it("for a bad or tampered token, in an answer the page can read", async () => {
      const { startSession, post } = await world();
      await refused(post, "not.a.real.token");
      const token = await startSession();
      await refused(post, `${token.slice(0, -2)}xx`);
      expect((await post("stream", "not json")).status).toBe(400);
    });

    it("for an expired session", async () => {
      const { startSession, post, timer } = await world();
      const token = await startSession();
      timer.advance(widgetSessionLastsMs);
      await refused(post, token);
    });

    it.each(["widgetKeyRotate", "widgetKeyDisable"] as const)("after %s", async (change) => {
      const { startSession, post, rpc, id } = await world();
      const token = await startSession();
      await rpc.representative[change]({ id });
      await refused(post, token);
    });
  });

  describe("with its session ending while it is open", () => {
    /** Only the stream's check is faked: the requests and jobs keep their real timers. */
    const fakeChecks = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const nextCheck = () => vi.advanceTimersByTime(sessionCheckMs);

    it("stays open and says nothing while the session is good", async () => {
      const { startSession, openStream } = await world();
      const token = await startSession();
      fakeChecks();
      const stream = await openStream(token);
      await expect.poll(() => stream.events, poll).toEqual([changed]);

      nextCheck();

      await expect.poll(() => stream.seen.raw, poll).toContain(": ping");
      expect(stream.events).toEqual([changed]);
      expect(stream.seen.closed).toBe(false);
    });

    it.each([
      ["disabled", "widgetKeyDisable"],
      ["rotated", "widgetKeyRotate"],
    ] as const)("tells the visitor when its key is %s", async (_name, change) => {
      const { startSession, openStream, rpc, id } = await world();
      const token = await startSession();
      fakeChecks();
      const stream = await openStream(token);
      await expect.poll(() => stream.events, poll).toEqual([changed]);

      await rpc.representative[change]({ id });
      nextCheck();

      await expect.poll(() => stream.events, poll).toEqual([changed, ended]);
      await expect.poll(() => stream.seen.closed, poll).toBe(true);
    });

    it("tells the visitor when its time runs out", async () => {
      const { startSession, openStream, timer } = await world();
      const token = await startSession();
      fakeChecks();
      const stream = await openStream(token);
      await expect.poll(() => stream.events, poll).toEqual([changed]);

      timer.advance(widgetSessionLastsMs);
      nextCheck();

      await expect.poll(() => stream.events, poll).toEqual([changed, ended]);
      await expect.poll(() => stream.seen.closed, poll).toBe(true);
    });
  });

  it("pings on when a check can't reach the database, which hasn't ended the session", async () => {
    const { startSession, openStream, deps } = await world();
    const token = await startSession();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream(token);
    await expect.poll(() => stream.events, poll).toEqual([changed]);
    const broken = vi.spyOn(deps.db, "select").mockImplementationOnce(() => {
      throw new Error("The database is away");
    });

    vi.advanceTimersByTime(sessionCheckMs);

    await expect.poll(() => stream.seen.raw, poll).toContain(": ping");
    expect(broken).toHaveBeenCalled();
    expect(stream.events).toEqual([changed]);
    expect(stream.seen.closed).toBe(false);
  });

  it("is limited per IP across sessions, and only for the IP the Host names", async () => {
    const { startSession, post, openStream } = await world(
      [],
      noCustomerChannel,
      undefined,
      createMemoryPubSub(),
      (request) => request.headers.get("x-test-ip"),
    );
    const open = (ip: string, token: string, signal: AbortSignal) =>
      post("stream", { token }, { "x-test-ip": ip }, signal);
    const stop = new AbortController();
    streams.push(stop);
    const first = new AbortController();
    streams.push(first);
    await open("203.0.113.9", await startSession(), first.signal);
    for (let at = 1; at < maxStreamsPerIp; at++) {
      const response = await open("203.0.113.9", await startSession(), stop.signal);
      expect(response.status).toBe(200);
    }

    const token = await startSession();
    await tooMany(await open("203.0.113.9", token, stop.signal));
    // A refusal by IP takes no place from its session, nor from another IP.
    for (let at = 0; at < maxStreamsPerSession; at++) {
      const response = await open("203.0.113.10", token, stop.signal);
      expect(response.status).toBe(200);
    }
    await openStream(await startSession());

    // A stream that ends gives its IP's place back.
    first.abort();
    await expect
      .poll(async () => (await open("203.0.113.9", await startSession(), stop.signal)).status, poll)
      .toBe(200);
  });

  it("lets go a page that gives up on a subscribe a Redis away holds, and keeps its place till then", async () => {
    const pubsub = createMemoryPubSub();
    const ended = vi.fn(async () => {});
    const held: ((end: () => Promise<void>) => void)[] = [];
    let holding = true;
    const { startSession, url, handler, openStream, post } = await world(
      [],
      noCustomerChannel,
      undefined,
      {
        publish: (channel, message) => pubsub.publish(channel, message),
        subscribe: (channel, listen) =>
          holding
            ? new Promise((resolve) => held.push(resolve))
            : pubsub.subscribe(channel, listen),
      },
    );
    const token = await startSession();
    const stop = new AbortController();
    const hanging = Array.from({ length: maxStreamsPerSession }, () =>
      handler(
        new Request(`${url}/representative/widget/stream`, {
          method: "POST",
          body: JSON.stringify({ token }),
          signal: stop.signal,
        }),
      ),
    );
    await expect.poll(() => held.length, poll).toBe(maxStreamsPerSession);

    stop.abort();
    await Promise.all(hanging);
    holding = false;
    // What waits on that Redis stays bounded, however often a page gives up and comes back.
    await tooMany(await post("stream", { token }));

    // The subscription that arrives once the page has gone doesn't stay.
    for (const arrive of held) arrive(ended);
    await expect.poll(() => ended.mock.calls.length, poll).toBe(maxStreamsPerSession);
    await openStream(token);
  });

  it("gives its places back when the subscribe fails", async () => {
    const pubsub = createMemoryPubSub();
    let failing = true;
    const { startSession, url, handler, openStream } = await world(
      [],
      noCustomerChannel,
      undefined,
      {
        publish: (channel, message) => pubsub.publish(channel, message),
        // Not async: a `PubSub` may throw as well as reject.
        subscribe: (channel, listen) => {
          if (failing) throw new Error("Redis is away");
          return pubsub.subscribe(channel, listen);
        },
      },
      (request) => request.headers.get("x-test-ip"),
    );
    const token = await startSession();
    // Straight to the handler: a Host's server aborts a request it has answered, which frees it too.
    for (let at = 0; at <= maxStreamsPerSession; at++) {
      await expect(
        handler(
          new Request(`${url}/representative/widget/stream`, {
            method: "POST",
            headers: { "x-test-ip": "203.0.113.11" },
            body: JSON.stringify({ token }),
          }),
        ),
      ).rejects.toThrow("Redis is away");
    }

    failing = false;

    await openStream(token);
  });

  it("hints when a Ban stops a message the page may have read", async () => {
    const { startSession, send, read, said, dueTurn, openStream, ban, jobs, timer } = await world([
      answers(),
      round(),
    ]);
    const token = await startSession();
    await send(token, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    await delivered();
    const [passed] = await getTestDb()
      .select({ id: representativeOutboundDecision.id })
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.kind, "reply"));
    const stream = await openStream(token);
    await expect.poll(() => stream.events, poll).toEqual([changed]);
    ban.on = true;

    await getTestDb().transaction((tx) =>
      jobs.enqueueIn(
        tx,
        customerDeliveryJobName,
        { decisionId: passed!.id },
        { idempotencyKey: "the retry" },
      ),
    );
    timer.tick();

    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    const [stopped] = await getTestDb()
      .select({
        outcome: representativeOutboundDecision.outcome,
        rule: representativeOutboundDecision.rule,
      })
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.rule, "owner_banned"));
    expect(stopped).toEqual({ outcome: "drop", rule: "owner_banned" });
    expect(await said(token)).toEqual([["customer", "Hello"]]);
  });

  it("is limited per session, and frees its place when the page goes", async () => {
    const { startSession, post, openStream } = await world();
    const token = await startSession();
    const open = [];
    for (let at = 0; at < maxStreamsPerSession; at++) open.push(await openStream(token));

    await tooMany(await post("stream", { token }));
    // Another session has its own.
    await openStream(await startSession());

    open[0]!.stop();

    await expect
      .poll(async () => {
        const again = await post("stream", { token });
        await again.body?.cancel();
        return again.status;
      }, poll)
      .toBe(200);
  });

  it("ends its body when the request aborts, which a Host's server is waiting on", async () => {
    const { startSession, url, handler } = await world();
    const token = await startSession();
    const stop = new AbortController();
    const response = await handler(
      new Request(`${url}/representative/widget/stream`, {
        method: "POST",
        body: JSON.stringify({ token }),
        signal: stop.signal,
      }),
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    stop.abort();

    expect((await reader.read()).done).toBe(true);
  });

  it("leaves a send answered while a publish waits on a Redis that's away", async () => {
    const pubsub = createMemoryPubSub();
    const { startSession, send } = await world([], noCustomerChannel, undefined, {
      subscribe: (channel, handler) => pubsub.subscribe(channel, handler),
      publish: () => new Promise(() => {}),
    });

    await send(await startSession(), "Hello");
  });

  it("hints when the owner undoes a merge, which can take words from this session", async () => {
    const { startSession, send, said, openStream, rpc } = await world();
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
    expect((await said(visitor)).flat()).toContain("After the merge");
    const stream = await openStream(visitor);
    await expect.poll(() => stream.events, poll).toEqual([changed]);
    const [merge] = await rpc.representative.customerMergeList();

    await rpc.representative.customerMergeUndo({ id: merge!.id });

    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    expect((await said(visitor)).flat()).not.toContain("After the merge");
  });

  it("makes no visible change for a message the gate held", async () => {
    const { startSession, send, said, dueTurn, openStream, id } = await world([answers(), round()]);
    await getTestDb().update(representative).set({ maxInARow: 0 }).where(eq(representative.id, id));
    const token = await startSession();
    const stream = await openStream(token);
    await send(token, "Hello");
    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    dueTurn();

    await expect.poll(() => decisionsOf("hold"), poll).toBe(1);

    expect(await said(token)).toEqual([["customer", "Hello"]]);
    await expect
      .poll(async () => {
        const [turn] = await getTestDb()
          .select({ status: job.status })
          .from(job)
          .where(eq(job.name, representativeTurnJobName));
        return turn?.status;
      }, poll)
      .toBe("succeeded");
    // Long enough for a hint published as the Turn ended to arrive.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stream.events).toEqual([changed, changed]);
  });

  it("recovers a lost hint on reconnect", async () => {
    const pubsub = createMemoryPubSub();
    let losing = false;
    const { startSession, send, read, said, dueTurn, openStream } = await world(
      [answers(), round()],
      noCustomerChannel,
      undefined,
      {
        subscribe: (channel, handler) => pubsub.subscribe(channel, handler),
        publish: async (channel, message) => {
          if (losing) throw new Error("Redis is away");
          await pubsub.publish(channel, message);
        },
      },
    );
    const token = await startSession();
    const first = await openStream(token);
    await expect.poll(() => first.events, poll).toEqual([changed]);

    losing = true;
    await send(token, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    expect(first.events).toEqual([changed]);
    first.stop();

    // A page re-reads on `changed`: the first one comes with no new message to set it off.
    const second = await openStream(token);
    await expect.poll(() => second.events, poll).toEqual([changed]);
    expect(await said(token)).toEqual([
      ["customer", "Hello"],
      ["business", "Noted."],
    ]);
  });

  it("ends its subscription when the page goes", async () => {
    const pubsub = createMemoryPubSub();
    const ends: string[] = [];
    const { startSession, openStream } = await world([], noCustomerChannel, undefined, {
      publish: (channel, message) => pubsub.publish(channel, message),
      subscribe: async (channel, handler) => {
        const end = await pubsub.subscribe(channel, handler);
        return async () => {
          ends.push(channel);
          await end();
        };
      },
    });
    const stream = await openStream(await startSession());
    await expect.poll(() => stream.events, poll).toEqual([changed]);
    expect(ends).toEqual([]);

    stream.stop();

    await expect.poll(() => ends.length, poll).toBe(1);
  });

  it("hints when delivery stops a message the page may have read", async () => {
    const { startSession, send, read, said, dueTurn, openStream, rpc, jobs, timer } = await world([
      answers(),
      round(),
    ]);
    const token = await startSession();
    await send(token, "Hello");
    dueTurn();
    await expect.poll(async () => (await read(token)).length, poll).toBe(2);
    await delivered();
    const [passed] = await getTestDb()
      .select({ id: representativeOutboundDecision.id })
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.kind, "reply"));
    const [customer] = await rpc.representative.customerList();
    await rpc.representative.customerSetBlocked({ id: customer!.id, blocked: true });
    const stream = await openStream(token);
    await expect.poll(() => stream.events, poll).toEqual([changed]);

    // A worker lost after the gate passed it, whose retry finds the Customer blocked since.
    await getTestDb().transaction((tx) =>
      jobs.enqueueIn(
        tx,
        customerDeliveryJobName,
        { decisionId: passed!.id },
        {
          idempotencyKey: "the retry",
        },
      ),
    );
    timer.tick();

    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    expect(await said(token)).toEqual([["customer", "Hello"]]);
  });

  it("hints when the owner deletes the Customer, whose words go", async () => {
    const { startSession, send, said, openStream, rpc } = await world();
    const token = await startSession();
    await send(token, "Hello");
    const stream = await openStream(token);
    await expect.poll(() => stream.events, poll).toEqual([changed]);
    const [customer] = await rpc.representative.customerList();

    await rpc.representative.customerDelete({ id: customer!.id });

    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    expect(await said(token)).toEqual([]);
  });

  it("hints when the owner corrects the address, which takes the words from this session", async () => {
    const { startSession, send, said, openStream, rpc } = await world();
    const token = await startSession();
    await send(token, "Hello");
    const stream = await openStream(token);
    await expect.poll(() => stream.events, poll).toEqual([changed]);
    const [customer] = await rpc.representative.customerList();
    const [identity] = customer!.identities;

    await rpc.representative.customerUpdateIdentity({
      id: customer!.id,
      identityId: identity!.id,
      channel: "sms",
      externalId: "+15550001111",
    });

    await expect.poll(() => stream.events, poll).toEqual([changed, changed]);
    expect(await said(token)).toEqual([]);
  });
});
