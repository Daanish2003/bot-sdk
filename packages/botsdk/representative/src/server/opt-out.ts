import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import type { OptOutSource } from "../shared/contract";
import { representativeCustomerIdentity, representativeThread } from "./db/schema";
import { type GateRefusal, passGate, storeAndDeliver, type ViaChannel } from "./outbound-gate";
import { replaceHeld, turnSender, waitingElsewhere } from "./reply-drafts";

/*
 * A Customer opts out and comes back (ticket #1302). An opt-out belongs to an identity, with how it
 * happened and when. A Channel's keyword or a Representative's flag sets it at once, with no model call,
 * and the Outbound gate's third rule drops what follows. The Customer is sent one fixed confirmation,
 * through the gate. `START`, or the owner, lifts it.
 */

/** What an opted-out Customer is sent once. */
export const optOutConfirmation =
  "You won't get any more messages from us. Reply START to hear from us again.";

type Words = { stop: readonly string[]; start: readonly string[] };

/** What the carriers' own rules make a text message to opt out with, and to come back with. */
const carrierWords: Words = {
  stop: ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"],
  start: ["start", "unstop"],
};

/**
 * The words that opt a Customer out and bring them back, by Channel. A text message reads like a
 * carrier's, and any other Channel only the plain ones, as a word like "end" in a mail is just a word.
 */
const channelWords: Record<string, Words> = { sms: carrierWords };
const plainWords: Words = { stop: ["stop", "unsubscribe"], start: ["start"] };

/** A message that is only a keyword, ignoring case, spaces and punctuation around it. */
export function keywordIn(channel: string, text: string): "stop" | "start" | null {
  const said = text
    .trim()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .toLowerCase();
  const words = channelWords[channel] ?? plainWords;
  if (words.stop.includes(said)) return "stop";
  if (words.start.includes(said)) return "start";
  return null;
}

type Heard = { channel: string; externalId: string };

/**
 * Opts the owner's identity at `heard` out. False when it was out already, or is no identity of
 * theirs: nothing changed, so nothing more is sent.
 */
export async function markOptedOut(
  tx: Transaction,
  userId: string,
  heard: Heard,
  source: OptOutSource,
  now: Date,
) {
  const identity = representativeCustomerIdentity;
  const marked = await tx
    .update(identity)
    .set({ optedOutAt: now, optOutSource: source })
    .where(
      and(
        eq(identity.userId, userId),
        eq(identity.channel, heard.channel),
        eq(identity.externalId, heard.externalId),
        isNull(identity.optedOutAt),
      ),
    )
    .returning({ id: identity.id });
  return marked.length > 0;
}

/** Lifts the opt-out of the owner's identity at `heard`. False when it wasn't out. */
export async function liftOptOut(tx: Transaction, userId: string, heard: Heard) {
  const identity = representativeCustomerIdentity;
  const lifted = await tx
    .update(identity)
    .set({ optedOutAt: null, optOutSource: null })
    .where(
      and(
        eq(identity.userId, userId),
        eq(identity.channel, heard.channel),
        eq(identity.externalId, heard.externalId),
        isNotNull(identity.optedOutAt),
      ),
    )
    .returning({ id: identity.id });
  return lifted.length > 0;
}

/**
 * Opts an identity out, and sends the fixed confirmation if the gate passes it: it skips the opt-out
 * rule, and nothing else a Customer who just asked to stop could object to. A blocked Customer gets
 * none. The thread's row must be held by `tx`, as the writes to the thread need it.
 */
export async function optOut(
  services: Pick<FeatureContext, "jobs"> & ViaChannel,
  tx: Transaction,
  {
    userId,
    threadId,
    heard,
    verified,
    source,
    now,
    releaseId,
    refusals,
  }: {
    userId: string;
    threadId: string;
    heard: Heard;
    verified: boolean;
    source: OptOutSource;
    now: Date;
    releaseId?: string | null;
    refusals?: GateRefusal[];
  },
) {
  if (!(await markOptedOut(tx, userId, heard, source, now))) return false;
  // The thread's row, so a draft a concurrent reply is writing is seen (or waits) before it is replaced.
  const [thread] = await tx
    .select({
      turnFrom: representativeThread.turnFrom,
      waitingFrom: representativeThread.waitingFrom,
    })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId))
    .for("update");
  // An opt-out is one address's: nothing waiting to go there can go any more, a draft the owner could
  // approve included, and what another address is owed still is, verified or not.
  await replaceHeld(tx, threadId, now, { ...heard, verified: false });
  // What this address said gets no Turn: its reply could not be sent.
  const waitingFrom =
    thread?.waitingFrom == null
      ? null
      : await waitingElsewhere(tx, threadId, thread.waitingFrom, heard);
  const batch =
    thread?.turnFrom == null ? undefined : await turnSender(tx, threadId, thread.turnFrom);
  const turnIsTheirs = batch?.channel === heard.channel && batch.externalId === heard.externalId;
  await tx
    .update(representativeThread)
    .set({
      waitingFrom,
      ...(waitingFrom === null && { waitingSince: null }),
      ...(turnIsTheirs && { turnFrom: null }),
    })
    .where(eq(representativeThread.id, threadId));
  const decision = await passGate(tx, {
    kind: "opt_out_confirmation",
    threadId,
    to: heard,
    now,
    releaseId,
    refusals,
    channel: services.channel,
    content: { text: optOutConfirmation, verified },
  });
  if (decision?.outcome !== "send") return true;
  await storeAndDeliver(
    services,
    tx,
    decision.id,
    { threadId, author: "note", text: optOutConfirmation, verified, ...heard },
    now,
  );
  return true;
}
