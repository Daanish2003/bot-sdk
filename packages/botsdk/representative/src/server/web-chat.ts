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
import { type CustomerChannel, webChatChannel } from "./customer-proof";
import {
  representative,
  representativeCustomerIdentity,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { receiveCustomerMessage } from "./thread-turns";
import { hintVisitor, visitorChannel } from "./visitor-hints";
import { readWidgetSession, widgetResponseHeaders, type WidgetSession } from "./widget-key";

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
  send: async (to, message) => {
    if (to.channel !== webChatChannel) await channel.send(to, message);
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
 * What this session said, and what the gate passed for it and nothing has stopped since: on any thread
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
      .where(and(eq(decision.messageId, message.id), eq(decision.outcome, outcome)));
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

const openStreams = new Map<string, number>();

const streamText = new TextEncoder();

/**
 * The stream of the session `token` opens, until the session ends or `signal` aborts. A failed
 * subscribe throws: the page sees a failed connection, and connects again.
 */
async function sessionStream(
  context: Pick<FeatureContext<"pubsub">, "db" | "keyring" | "clock" | "logger" | "pubsub">,
  token: string,
  { heard: { externalId } }: WidgetSession,
  signal: AbortSignal,
) {
  const opened = openStreams.get(externalId) ?? 0;
  if (opened >= maxStreamsPerSession) return refusal("error.tooManyRequests", 429);
  openStreams.set(externalId, opened + 1);
  const release = () => {
    const left = openStreams.get(externalId)! - 1;
    if (left > 0) openStreams.set(externalId, left);
    else openStreams.delete(externalId);
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
  let unsubscribe: () => Promise<void>;
  try {
    unsubscribe = await context.pubsub.subscribe(visitorChannel(externalId), () =>
      say({ type: "changed" }),
    );
  } catch (caught) {
    release();
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
  const checks = setInterval(() => void check(), sessionCheckMs);
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(checks);
    signal.removeEventListener("abort", close);
    release();
    unsubscribe().catch((caught: unknown) => {
      context.logger.error("Ending a web chat stream's subscription failed", caught);
    });
  };
  /** Ends the body too, which whatever is reading it is waiting on. */
  const close = () => {
    if (!open) return;
    finish();
    controller.close();
  };
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  // After subscribing, so what changed before this is re-read, and what changes after it is hinted.
  say({ type: "changed" });
  return new Response(stream, {
    headers: { ...widgetResponseHeaders, "content-type": "text/event-stream" },
  });
}

/** The routes of a visitor with a session, sending by way of `channel`. */
export const webChatRoutes = (channel: CustomerChannel): PublicRoute<"pages" | "pubsub">[] => [
  {
    method: "POST",
    path: "/representative/widget/send",
    handle: async (request, { context }) => {
      const body = await parsedBody(request, webChatSendInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      const received = await receiveCustomerMessage(
        { ...context, channel },
        {
          representativeId: session.representativeId,
          ...session.heard,
          // No proof: until a Channel can send a code, every web chat session stays unverified.
          message: body.text,
        },
      );
      if (!received) return ended();
      // Stored nowhere, so a page that heard nothing else would wait for a reply that isn't coming.
      if ("limited" in received) return refusal("error.tooManyRequests", 429);
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
      const body = await parsedBody(request, webChatReadInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      return sessionStream(context, body.token, session, request.signal);
    },
  },
];
