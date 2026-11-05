import { and, desc, eq, exists, notExists, or, sql } from "drizzle-orm";

import { readBody } from "@botsdk/bot/bot/routines";
import type { FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import {
  maxThreadMessageLength,
  webChatReadInput,
  webChatSendInput,
  type WebChatMessage,
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
import { readWidgetSession, widgetResponseHeaders, type WidgetSession } from "./widget-key";

/*
 * A web chat visitor sends and reads with their session token, and no signed-in user (ticket #1336).
 * Both are POSTs with the token in a plain-text body, which a browser sends across origins with no
 * preflight, and no cookie or sign-in is read. The token alone says who they are, so any page holding
 * one can read the answer: session start is what the origin list guards.
 *
 * A message takes the path every Customer message does. Web chat has no platform in front of it: what
 * the gate lets through is stored on the thread, and the visitor reads it from there.
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

/** The routes of a visitor with a session, sending by way of `channel`. */
export const webChatRoutes = (channel: CustomerChannel): PublicRoute<"pages">[] => [
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
];
