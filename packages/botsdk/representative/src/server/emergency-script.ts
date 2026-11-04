import { eq } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { representative, representativeThread } from "./db/schema";
import { type GateRefusal, passGate, storeAndDeliver } from "./outbound-gate";

/*
 * The emergency script (ticket #1308): a Release's fixed safety text, which a keyword in that Release
 * or a Representative's flag sets off. It passes only the gate's block and Channel rules, and it Pages
 * the owner at once. No Model writes a word of it.
 */

/** Spaces in a run count as one, and case doesn't count, so a keyword doesn't turn on how it was typed. */
const plain = (text: string) => text.toLowerCase().replace(/\s+/gu, " ").trim();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Whether `text` says one of `keywords`, as whole words: "fire" isn't in "fired". */
export function saysKeyword(keywords: readonly string[], text: string) {
  const said = plain(text);
  return keywords.some((keyword) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escaped(plain(keyword))}(?![\\p{L}\\p{N}])`, "u").test(said),
  );
}

/**
 * Sends `text`, the script of the Release in effect, to `heard`, if the gate passes it. The owner is
 * Paged unless the Customer is blocked: they chose not to hear from them, and an emergency Page gets
 * through at any hour. Takes the thread's row, as the writes to it need it; a caller holding the
 * Customer's row took it first.
 */
export async function sendEmergencyScript(
  services: Pick<FeatureContext<"pages">, "jobs" | "pages">,
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
  if (!owner) return;
  const decision = await passGate(tx, {
    kind: "emergency_script",
    threadId,
    to: heard,
    now,
    releaseId,
    refusals,
    content: { text, verified },
  });
  if (decision?.outcome === "send") {
    await storeAndDeliver(
      services,
      tx,
      decision.id,
      { threadId, author: "note", text, verified, ...heard },
      now,
    );
  }
  if (decision && decision.rule !== "blocked") {
    await services.pages.send(tx, {
      userId: owner.userId,
      cause: "emergency_script",
      urgency: "emergency",
      title: "A Customer may have an emergency",
      text: `${owner.name} sent a Customer its emergency script. Open the thread to see what they said.`,
      path: `/representatives/${owner.representativeId}`,
    });
  }
}
