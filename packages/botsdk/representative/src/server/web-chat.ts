import { and, desc, eq, exists, notExists, or, sql } from "drizzle-orm";

import { readBody } from "@botsdk/bot/bot/routines";
import type { FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import {
  maxThreadMessageLength,
  webChatReadInput,
  webChatSendInput,
  type WebChatMessage,
  type WebChatStreamEvent,
} from "../shared/contract";
import { type ChannelOf, type CustomerChannel, webChatChannel } from "./customer-proof";
import {
  representative,
  representativeCustomerIdentity,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { receiveCustomerMessage } from "./thread-turns";
import { hintVisitor, visitorChannel } from "./visitor-hints";
import {
  clientIpOf,
  limitSendByIp,
  limitSendBySession,
  limitStreamByIp,
  type ClientIp,
} from "./web-chat-limits";
import {
  readWidgetSession,
  tooManyRequests,
  widgetResponseHeaders,
  type WidgetSession,
} from "./widget-key";

/*
 * A web chat visitor sends and reads with their session token, and no signed-in user (ticket #1336).
 * Both are POSTs with the token in a plain-text body, which a browser sends across origins with no
 * preflight, and no cookie or sign-in is read. The token alone says who they are, so any page holding
 * one can read the answer: session start is what the origin list guards.
 *
 * A message takes the path every Customer message does. Web chat has no platform in front of it: what
 * the gate lets through is stored on the thread, and the visitor reads it from there.
 *
 * The stream is a POST for the same reason, and so the token stays out of URLs and logs. That rules
 * out `EventSource`: a page reads it with `fetch` (ticket #1339). It carries hints and no message.
 */

/** The most a request's body can be: a whole message, each character at the six bytes JSON can write it in, and its token. */
const bodyLimit = maxThreadMessageLength * 6 + 1024;

/** The most messages a read returns, newest kept. */
const readLimit = 200;

/**
 * `channel`, with web chat reached by the thread itself: nothing to send, and only the visitor can
 * start a conversation.
 */
export const withWebChat = (channel: CustomerChannel): CustomerChannel => ({
  send: async (to, message, via) => {
    if (to.channel !== webChatChannel) await channel.send(to, message, via);
  },
  sendProof: async (to, proof) => {
    if (to.channel !== webChatChannel) await channel.sendProof(to, proof);
  },
  reach: (name) =>
    name === webChatChannel ? { canStartConversation: false } : channel.reach?.(name),
});

const answer = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: widgetResponseHeaders });

const refusal = (code: string, status: number) => answer({ code, params: {} }, status);

/** Tells a visitor their token no longer opens anything, whatever was wrong with it. */
const ended = () => refusal("error.widgetSessionEnded", 401);

const invalid = () => refusal("error.widgetMessageInvalid", 400);

/** The body as `schema` has it, or null for one too long, not JSON, or not that shape. */
async function parsedBody<T>(
  request: Request,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | null> {
  const body = await readBody(request, bodyLimit);
  if (body === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What this session said, and what the gate passed for it, was delivered, and nothing has stopped since: on any thread
 * of its Customer with this Representative, as an idle thread closes and the next message opens another.
 * The Customer only finds the threads, by indexes: the owner can merge another's words on to one, so each
 * message must be this session's too. A Bot's result has no decision, and what the gate held isn't on the
 * thread until it passes. A merge can put a session's next words on an older thread, so threads come in
 * the order of their newest message, each in its own order.
 */
async function readMessages(
  { db }: Pick<FeatureContext, "db">,
  { representativeId, heard }: WidgetSession,
): Promise<WebChatMessage[]> {
  const message = representativeThreadMessage;
  const thread = representativeThread;
  const decision = representativeOutboundDecision;
  const identity = representativeCustomerIdentity;
  const decided = (outcome: "send" | "drop") =>
    db
      .select({ id: decision.id })
      .from(decision)
      .where(
        and(
          eq(decision.messageId, message.id),
          eq(decision.outcome, outcome),
          // A send counts once its delivery ran: until then, a block or a Ban can still stop it.
          outcome === "send" ? sql`(${decision.sentOn} ->> 'delivered') = 'true'` : undefined,
        ),
      );
  const newest = await db
    .select({ id: message.id, author: message.author, text: message.text })
    .from(message)
    .innerJoin(thread, eq(thread.id, message.threadId))
    .innerJoin(representative, eq(representative.id, thread.representativeId))
    .innerJoin(
      identity,
      and(
        eq(identity.userId, representative.userId),
        eq(identity.customerId, thread.customerId),
        eq(identity.channel, heard.channel),
        eq(identity.externalId, heard.externalId),
      ),
    )
    .where(
      and(
        eq(thread.representativeId, representativeId),
        eq(message.channel, heard.channel),
        eq(message.externalId, heard.externalId),
        or(
          eq(message.author, "customer"),
          and(exists(decided("send")), notExists(decided("drop"))),
        ),
      ),
    )
    .orderBy(
      desc(sql`max(${message.id}::text) over (partition by ${message.threadId})`),
      desc(message.position),
    )
    .limit(readLimit);
  return newest.reverse().map(({ id, author, text }) => ({
    id,
    from: author === "customer" ? ("customer" as const) : ("business" as const),
    text,
  }));
}

/**
 * How often an open stream pings and checks its session. Nothing announces a session's end, whether
 * its time ran out or its key was rotated, disabled or deleted: this notices, with no hint to lose.
 */
export const sessionCheckMs = 25_000;

/** The most streams one session holds open in a process: a few tabs, and a reconnect or two. */
export const maxStreamsPerSession = 5;

/**
 * The most streams one IP holds open in a process, across its sessions. A stream holds its place for
 * up to a day, so the limit on starting sessions alone would let an IP gather thousands.
 */
export const maxStreamsPerIp = 50;

/** What a page refused a stream is told to wait: a place frees whenever another stream ends. */
const streamRetrySeconds = 30;

const openStreams = new Map<string, number>();

/** Takes one of `most` places under `key`, and returns how to give it back, or null with none left. */
function takeStream(key: string, most: number) {
  const opened = openStreams.get(key) ?? 0;
  if (opened >= most) return null;
  openStreams.set(key, opened + 1);
  return () => {
    const left = openStreams.get(key)! - 1;
    if (left > 0) openStreams.set(key, left);
    else openStreams.delete(key);
  };
}

const streamText = new TextEncoder();

/**
 * The stream of the session `token` opens, until the session ends or `signal` aborts. A failed
 * subscribe throws: the page sees a failed connection, and connects again. A Redis that's away holds
 * the subscribe until it's back: a page that gives up meanwhile is let go, and its places stay taken
 * until then, since they are what bounds the subscribes waiting on that Redis.
 */
async function sessionStream(
  context: Pick<FeatureContext<"pubsub">, "db" | "keyring" | "clock" | "logger" | "pubsub">,
  token: string,
  { heard: { externalId } }: WidgetSession,
  signal: AbortSignal,
  ip: string | null | undefined,
) {
  const sessionPlace = takeStream(`session:${externalId}`, maxStreamsPerSession);
  if (!sessionPlace) return tooManyRequests(streamRetrySeconds);
  const ipPlace = ip ? takeStream(`ip:${ip}`, maxStreamsPerIp) : () => {};
  if (!ipPlace) {
    sessionPlace();
    return tooManyRequests(streamRetrySeconds);
  }
  const release = () => {
    sessionPlace();
    ipPlace();
  };

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const write = (chunk: string) => {
    if (open) controller.enqueue(streamText.encode(chunk));
  };
  const say = (event: WebChatStreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start: (given) => {
      controller = given;
    },
    cancel: () => finish(),
  });
  let checks: ReturnType<typeof setInterval> | undefined;
  let finished!: () => void;
  const gone = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(checks);
    signal.removeEventListener("abort", close);
    finished();
  };
  /** Ends the body too, which whatever is reading it is waiting on. */
  const close = () => {
    if (!open) return;
    finish();
    controller.close();
  };
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  // In a function, so that a `PubSub` that throws rather than rejects gives its places back too.
  const subscribing = (async () =>
    context.pubsub.subscribe(visitorChannel(externalId), () => say({ type: "changed" })))();
  const settled = gone.then(() => subscribing).finally(release);
  settled
    .then((unsubscribe) => unsubscribe())
    .catch((caught: unknown) => {
      context.logger.error("A web chat stream's subscription failed", caught);
    });
  try {
    await Promise.race([subscribing, gone]);
  } catch (caught) {
    finish();
    await settled.catch(() => {});
    throw caught;
  }
  let checking = false;
  const check = async () => {
    // Whatever the check finds, so a slow database doesn't get a good connection cut as idle.
    write(": ping\n\n");
    if (checking) return;
    checking = true;
    try {
      if (!(await readWidgetSession(context, token)) && open) {
        say({ type: "ended", code: "error.widgetSessionEnded" });
        close();
      }
    } catch (caught) {
      // The next check asks again: a database that's down hasn't ended anyone's session.
      context.logger.error("Checking a web chat stream's session failed", caught);
    } finally {
      checking = false;
    }
  };
  if (open) checks = setInterval(() => void check(), sessionCheckMs);
  // After subscribing, so what changed before this is re-read, and what changes after it is hinted.
  say({ type: "changed" });
  return new Response(stream, {
    headers: { ...widgetResponseHeaders, "content-type": "text/event-stream" },
  });
}

/** The routes of a visitor with a session, sending by way of `channelOf`'s Channel. */
export const webChatRoutes = (
  channelOf: ChannelOf,
  clientIp?: ClientIp,
): PublicRoute<"channelAccounts" | "counters" | "pages" | "pubsub">[] => [
  {
    method: "POST",
    path: "/representative/widget/send",
    handle: async (request, { context }) => {
      // The limits come before the inbound limit's scan of the owner's messages, so these bound it.
      const ipWait = await limitSendByIp(context, request, clientIp);
      if (ipWait !== null) return tooManyRequests(ipWait);
      const body = await parsedBody(request, webChatSendInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      const sessionWait = await limitSendBySession(context, session.heard.externalId);
      if (sessionWait !== null) return tooManyRequests(sessionWait);
      const received = await receiveCustomerMessage(
        { ...context, channel: channelOf(context) },
        {
          representativeId: session.representativeId,
          ...session.heard,
          // No proof: until a Channel can send a code, every web chat session stays unverified.
          message: body.text,
        },
      );
      if (!received) return ended();
      // Stored nowhere, so a page that heard nothing else would wait for a reply that isn't coming.
      if (received.limited) {
        return tooManyRequests(Math.max(1, Math.ceil(received.retryAfterMs / 1000)));
      }
      hintVisitor(context, session.heard);
      return answer({}, 202);
    },
  },
  {
    method: "POST",
    path: "/representative/widget/read",
    handle: async (request, { context }) => {
      const body = await parsedBody(request, webChatReadInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      return answer({ messages: await readMessages(context, session) });
    },
  },
  {
    method: "POST",
    path: "/representative/widget/stream",
    handle: async (request, { context }) => {
      const ipWait = await limitStreamByIp(context, request, clientIp);
      if (ipWait !== null) return tooManyRequests(ipWait);
      const body = await parsedBody(request, webChatReadInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      return sessionStream(
        context,
        body.token,
        session,
        request.signal,
        clientIpOf(request, clientIp),
      );
    },
  },
];
