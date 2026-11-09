import { and, eq, isNull } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { page } from "@botsdk/bot/storage";
import {
  representative,
  representativeCustomer,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
} from "./db/schema";
import {
  dropHeld,
  type GateRefusal,
  passGate,
  storeAndDeliver,
  type ViaChannel,
} from "./outbound-gate";

/*
 * The emergency script (ticket #1308): a Release's fixed safety text, which a keyword in that Release
 * or a Representative's flag sets off. It passes only the gate's block and Channel rules, and it Pages
 * the owner at once. No Model writes a word of it.
 */

/** Spaces in a run count as one, and neither case nor how an accent is encoded counts, so a keyword doesn't turn on how it was typed. */
const plain = (text: string) => text.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Whether `text` says one of `keywords`, as whole words: "fire" isn't in "fired". */
export function saysKeyword(keywords: readonly string[], text: string) {
  const said = plain(text);
  return keywords.some((keyword) =>
    new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}])${escaped(plain(keyword))}(?![\\p{L}\\p{M}\\p{N}])`,
      "u",
    ).test(said),
  );
}

/**
 * Lets go of whatever would answer the thread, whose row `tx` holds, as a keyword has just told the
 * Customer what to do: a running Turn stops, so nothing it says comes after the script, and what waited
 * goes with it. The owner has that left for them, as they've been Paged.
 */
export async function stopForScript(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  threadId: string,
  now: Date,
) {
  const [thread] = await tx
    .select({
      turnId: representativeThread.turnId,
      turnFrom: representativeThread.turnFrom,
      waitingFrom: representativeThread.waitingFrom,
    })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId))
    .for("update");
  if (!thread) return;
  if (thread.turnId) await jobs.cancelIn(tx, thread.turnId);
  await tx
    .update(representativeThread)
    .set({
      turnId: null,
      turnFrom: null,
      waitingFrom: null,
      waitingSince: null,
      ...((thread.turnFrom !== null || thread.waitingFrom !== null) && { leftForOwnerAt: now }),
    })
    .where(eq(representativeThread.id, threadId));
}

/** The thread's owner, with its row held, as the writes to it need it; a caller holding the Customer's row took it first. */
async function holdThreadOwner(tx: Transaction, threadId: string) {
  const [owner] = await tx
    .select({
      userId: representative.userId,
      representativeId: representative.id,
      name: representative.name,
    })
    .from(representativeThread)
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(eq(representativeThread.id, threadId))
    .for("update", { of: representativeThread });
  return owner;
}

type ThreadOwner = NonNullable<Awaited<ReturnType<typeof holdThreadOwner>>>;

/**
 * Pages `owner` of an emergency on `threadId`, unless the thread's last emergency Page is still
 * unacknowledged: a Customer repeating themselves isn't a new alarm. `evenIfPaged` is for news that
 * Page didn't carry.
 */
async function sendEmergencyPage(
  { pages }: Pick<FeatureContext<"pages">, "pages">,
  tx: Transaction,
  owner: ThreadOwner,
  threadId: string,
  text: string,
  evenIfPaged = false,
) {
  const cause = `emergency_script:${threadId}`;
  const [unacknowledged] = await tx
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.userId, owner.userId), eq(page.cause, cause), isNull(page.acknowledgedAt)))
    .limit(1);
  if (unacknowledged && !evenIfPaged) return;
  await pages.send(tx, {
    userId: owner.userId,
    cause,
    urgency: "emergency",
    title: "A Customer may have an emergency",
    text,
    path: `/representatives/${owner.representativeId}`,
  });
}

/**
 * Pages the owner of an emergency on `threadId` with no script to send, for when something else tells
 * the Customer what to do: nothing goes to them and nothing is stored on the thread. The same Page as
 * `sendEmergencyScript`'s and the same dedupe, which each one's Pages count toward; a blocked Customer
 * Pages no one, as there. Takes the thread's row; a caller holding the Customer's row took it first.
 */
export async function pageEmergency(
  services: Pick<FeatureContext<"pages">, "pages">,
  tx: Transaction,
  { threadId }: { threadId: string },
) {
  const owner = await holdThreadOwner(tx, threadId);
  if (!owner) return;
  const [customer] = await tx
    .select({ blockedAt: representativeCustomer.blockedAt })
    .from(representativeThread)
    .innerJoin(
      representativeCustomer,
      eq(representativeCustomer.id, representativeThread.customerId),
    )
    .where(eq(representativeThread.id, threadId));
  if (customer?.blockedAt) return;
  await sendEmergencyPage(
    services,
    tx,
    owner,
    threadId,
    `${owner.name} heard a Customer report an emergency. Open the thread to reach them.`,
  );
}

/**
 * Sends `text`, the script of the Release in effect, to `heard`, if the gate passes it. The owner is
 * Paged unless the Customer is blocked (they chose not to hear from them, and an emergency Page gets
 * through at any hour) or the thread's last emergency Page is still unacknowledged: a Customer repeating
 * themselves isn't a new alarm. Held by the Channel's limits, it waits for the owner to send it, and the
 * Page says so. The script answers the Turn's batch. Takes the thread's row, as the writes
 * to it need it; a caller holding the Customer's row took it first.
 */
export async function sendEmergencyScript(
  services: Pick<FeatureContext<"pages">, "jobs" | "pages"> & ViaChannel,
  tx: Transaction,
  {
    threadId,
    heard,
    verified,
    text,
    now,
    releaseId,
    refusals,
  }: {
    threadId: string;
    heard: { channel: string; externalId: string };
    verified: boolean;
    text: string;
    now: Date;
    releaseId?: string | null;
    refusals?: GateRefusal[];
  },
) {
  const owner = await holdThreadOwner(tx, threadId);
  if (!owner) return;
  // Saying it again leaves one to send: this one goes or waits in its place.
  const waiting = await tx
    .select({ id: representativeHeldMessage.id })
    .from(representativeHeldMessage)
    .innerJoin(
      representativeOutboundDecision,
      eq(representativeOutboundDecision.id, representativeHeldMessage.decisionId),
    )
    .where(
      and(
        eq(representativeHeldMessage.threadId, threadId),
        isNull(representativeHeldMessage.resolution),
        eq(representativeOutboundDecision.kind, "emergency_script"),
      ),
    );
  for (const { id } of waiting) {
    await dropHeld(tx, { threadId, heldId: id, kind: "emergency_script", rule: "replaced", now });
  }
  const decision = await passGate(tx, {
    kind: "emergency_script",
    threadId,
    to: heard,
    now,
    releaseId,
    refusals,
    channel: services.channel,
    content: { text, verified },
  });
  if (decision?.outcome === "send") {
    await storeAndDeliver(
      services,
      tx,
      decision.id,
      { threadId, author: "note", text, verified, ...heard },
      now,
      { turnFrom: null },
    );
  }
  if (!decision || decision.rule === "blocked") return;
  // A Page saying one went doesn't tell the owner this one waits for them, unless one is waiting already.
  const newlyHeld = decision.outcome === "hold" && waiting.length === 0;
  await sendEmergencyPage(
    services,
    tx,
    owner,
    threadId,
    decision.outcome === "send"
      ? `${owner.name} sent a Customer its emergency script. Open the thread to see what they said.`
      : `${owner.name} couldn't send a Customer its emergency script: the Channel's limits stopped it. Open the thread to send it.`,
    newlyHeld,
  );
}
