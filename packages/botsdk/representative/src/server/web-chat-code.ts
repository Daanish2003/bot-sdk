import { and, eq, ne } from "drizzle-orm";

import type { FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { webChatCodeCheckInput, webChatCodeRequestInput } from "../shared/contract";
import {
  type ChannelOf,
  type CustomerChannel,
  passCode,
  requestProof,
  smsChannel,
} from "./customer-proof";
import { holdSender } from "./customers";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
} from "./db/schema";
import { customerEmailChannel } from "./email-address";
import { hintVisitor } from "./visitor-hints";
import { answer, ended, invalid, parsedBody, refusal } from "./web-chat";
import {
  limitCodeCheckByIp,
  limitCodeCheckBySession,
  limitCodeRequestByIp,
  limitCodeRequestBySession,
  type ClientIp,
} from "./web-chat-limits";
import { readWidgetSession, tooManyRequests, type WidgetSession } from "./widget-key";

/*
 * A web chat visitor proves who they are with a code sent to an email address on record (ticket
 * #1350), or texted to a phone number on record (ticket #1361). They give the address or number in the chat window, never in the chat, so no Model reads it. The code
 * goes only to an email identity the owner's records hold as verified, and the request is answered
 * the same whether or not one went. The right code, entered in the chat window, joins the session to
 * that Customer, as a code passed in a message does (`customer-proof.ts`), and proves it for an hour.
 *
 * Both routes need the session's thread: a visitor who hasn't written has nothing to verify yet.
 */

type Context = FeatureContext<"channelAccounts" | "counters" | "pages" | "pubsub">;

/** The visitor's open thread with the Representative, and what decides the proof. */
async function visitorThread(tx: Transaction, { representativeId, heard }: WidgetSession) {
  const identity = representativeCustomerIdentity;
  const [found] = await tx
    .select({
      userId: representative.userId,
      releaseId: representative.liveReleaseId,
      threadId: representativeThread.id,
      provenUntil: identity.provenUntil,
    })
    .from(identity)
    .innerJoin(representative, eq(representative.userId, identity.userId))
    .innerJoin(
      representativeThread,
      and(
        eq(representativeThread.customerId, identity.customerId),
        eq(representativeThread.representativeId, representative.id),
        ne(representativeThread.state, "closed"),
      ),
    )
    .where(
      and(
        eq(representative.id, representativeId),
        eq(identity.channel, heard.channel),
        eq(identity.externalId, heard.externalId),
      ),
    );
  return found;
}

/**
 * Makes a code for the session if `claimed` is a verified email or SMS identity on record, and sends it once
 * that commits. Its route doesn't wait for it: nothing it finds changes what the visitor is told.
 */
async function requestCode(
  context: Context,
  channel: CustomerChannel,
  session: WidgetSession,
  claimed: { channel: string; externalId: string },
) {
  const outgoing = await context.db.transaction(async (tx) => {
    const now = context.clock();
    const found = await visitorThread(tx, session);
    if (!found) return null;
    return requestProof(tx, {
      keyring: context.keyring,
      userId: found.userId,
      thread: {
        threadId: found.threadId,
        heard: session.heard,
        verified: found.provenUntil !== null && now < found.provenUntil,
        proofRule: "codeToRecord",
        releaseId: found.releaseId,
      },
      claimed,
      now,
      channel,
      verifiedTargetOnly: true,
    });
  });
  if (!outgoing) return;
  const { to, proof } = outgoing;
  await channel.sendProof(to, proof, {
    representativeId: session.representativeId,
    chatWindow: true,
  });
}

/** Code requests still at work, which a test waits for before it clears the database. */
const pending = new Set<Promise<void>>();

/** Resolves once every code request under way has finished. */
export const codeRequestsSettled = async () => {
  await Promise.all(pending);
};

/** Whether `code` is the session's live code, which then joins it to its Customer and proves it. */
async function checkCode(
  context: Context,
  channel: CustomerChannel,
  { representativeId, heard }: WidgetSession,
  code: string,
) {
  return context.db.transaction(async (tx) => {
    const now = context.clock();
    // The Representative's row first, the order a Customer's message takes them in.
    const [owner] = await tx
      .select({ userId: representative.userId })
      .from(representative)
      .where(eq(representative.id, representativeId))
      .for("key share");
    if (!owner) return false;
    // A session that hasn't written has no identity, and so no code: none is made for it here.
    const [known] = await tx
      .select({ id: representativeCustomerIdentity.id })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.userId, owner.userId),
          eq(representativeCustomerIdentity.channel, heard.channel),
          eq(representativeCustomerIdentity.externalId, heard.externalId),
        ),
      );
    if (!known) return false;
    const { identityId, customerId } = await holdSender(tx, owner.userId, heard, code, now);
    const [customer] = await tx
      .select({ blockedAt: representativeCustomer.blockedAt })
      .from(representativeCustomer)
      .where(eq(representativeCustomer.id, customerId));
    return passCode(tx, {
      services: { ...context, channel },
      identityId,
      customerId,
      blocked: customer?.blockedAt != null,
      code,
      now,
    });
  });
}

/** The routes a visitor asks for a code and enters it by, sending by way of `channelOf`'s Channel. */
export const webChatCodeRoutes = (
  channelOf: ChannelOf,
  clientIp?: ClientIp,
): PublicRoute<"channelAccounts" | "counters" | "pages" | "pubsub">[] => [
  {
    method: "POST",
    path: "/representative/widget/code",
    handle: async (request, { context }) => {
      const ipWait = await limitCodeRequestByIp(context, request, clientIp);
      if (ipWait !== null) return tooManyRequests(ipWait);
      const body = await parsedBody(request, webChatCodeRequestInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      const sessionWait = await limitCodeRequestBySession(context, session.heard.externalId);
      if (sessionWait !== null) return tooManyRequests(sessionWait);
      // Not waited for, and the same answer whatever is found: neither what it says nor how long it
      // takes may tell anyone which addresses are on record.
      const claimed =
        "email" in body
          ? { channel: customerEmailChannel, externalId: body.email }
          : { channel: smsChannel, externalId: body.phone };
      const work = requestCode(context, channelOf(context), session, claimed)
        .catch((error: unknown) => {
          context.logger.error("A web chat code request failed", error);
        })
        .finally(() => pending.delete(work));
      pending.add(work);
      return answer({}, 202);
    },
  },
  {
    method: "POST",
    path: "/representative/widget/code/check",
    handle: async (request, { context }) => {
      const ipWait = await limitCodeCheckByIp(context, request, clientIp);
      if (ipWait !== null) return tooManyRequests(ipWait);
      const body = await parsedBody(request, webChatCodeCheckInput);
      if (!body) return invalid();
      const session = await readWidgetSession(context, body.token);
      if (!session) return ended();
      const sessionWait = await limitCodeCheckBySession(context, session.heard.externalId);
      if (sessionWait !== null) return tooManyRequests(sessionWait);
      if (!(await checkCode(context, channelOf(context), session, body.code))) {
        return refusal("error.widgetCodeWrong", 400);
      }
      hintVisitor(context, session.heard);
      return answer({ verified: true });
    },
  },
];
