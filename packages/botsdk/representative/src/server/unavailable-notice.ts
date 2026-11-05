import { and, eq } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { representativeOutboundDecision } from "./db/schema";
import { passGate, storeAndDeliver, type ViaChannel } from "./outbound-gate";

/*
 * The notice for a Customer who writes when nobody can answer (ticket #1332): the Representative is
 * switched off, or has no approved Release. It is fixed text, so no Model writes it and none is called,
 * and it goes once to each thread. The Outbound gate decides it as its own kind of message, so the owner
 * finds it in the decision log.
 */

/** What a Customer hears when nobody can answer: fixed, and promises nothing. */
export const unavailableNotice = "We can't answer right now. Please try again later.";

/**
 * Sends the notice to `heard` on thread `threadId`, whose row `tx` holds, unless this thread has had one
 * already. The caller sends none to a blocked or opted-out Customer; the gate checks them too.
 */
export async function sendUnavailableNotice(
  services: Pick<FeatureContext, "jobs"> & ViaChannel,
  tx: Transaction,
  {
    threadId,
    heard,
    verified,
    now,
  }: {
    threadId: string;
    heard: { channel: string; externalId: string };
    verified: boolean;
    now: Date;
  },
) {
  const [told] = await tx
    .select({ id: representativeOutboundDecision.id })
    .from(representativeOutboundDecision)
    .where(
      and(
        eq(representativeOutboundDecision.threadId, threadId),
        eq(representativeOutboundDecision.kind, "unavailable_notice"),
        eq(representativeOutboundDecision.outcome, "send"),
      ),
    )
    .limit(1);
  if (told) return;
  const decision = await passGate(tx, {
    kind: "unavailable_notice",
    threadId,
    to: heard,
    now,
    channel: services.channel,
    content: { text: unavailableNotice, verified },
  });
  if (decision?.outcome !== "send") return;
  await storeAndDeliver(
    services,
    tx,
    decision.id,
    { threadId, author: "note", text: unavailableNotice, verified, ...heard },
    now,
  );
}
