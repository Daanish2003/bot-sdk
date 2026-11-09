import { and, eq } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { page } from "@botsdk/bot/storage";
import { holdThreadOwner } from "./emergency-script";

/*
 * A bad Call's flag (ticket #1386, ADR 0036): the post-call Turn found something the Voice agent said
 * outside the `auto` rules, or a claim the published facts don't support. It Pages the owner, and sends
 * the Customer nothing.
 */

export const callFlagCause = (callId: string) => `call_flagged:${callId}`;

/**
 * Pages the owner of `threadId` that Call `callId` went wrong in the way `what` says. Once per Call:
 * whether or not the owner has acknowledged the Page, a Call that has had one has none again. Takes the
 * thread's row, so two flags of one Call wait for each other. Says whether a Page went.
 */
export async function flagCall(
  { pages }: Pick<FeatureContext<"pages">, "pages">,
  tx: Transaction,
  { threadId, callId, what }: { threadId: string; callId: string; what: string },
) {
  const owner = await holdThreadOwner(tx, threadId);
  if (!owner) return false;
  const cause = callFlagCause(callId);
  const [paged] = await tx
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.userId, owner.userId), eq(page.cause, cause)))
    .limit(1);
  if (paged) return false;
  await pages.send(tx, {
    userId: owner.userId,
    cause,
    urgency: "routine",
    title: "A Call may have gone wrong",
    text: `${owner.name} reviewed a Call and flagged it (thread ${threadId}): ${what}`,
    path: `/representatives/${owner.representativeId}`,
  });
  return true;
}
