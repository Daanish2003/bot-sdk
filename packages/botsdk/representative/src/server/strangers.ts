import type { FeatureContext, StrangerMessage } from "@botsdk/bot/feature";
import { eq } from "drizzle-orm";

import { representative, representativeChannelAccount } from "./db/schema";
import { maxThreadMessageLength } from "../shared/contract";
import { receiveCustomerMessage } from "./thread-turns";

/*
 * Everyone who writes to a Channel account a Representative holds is a Customer (ticket #1334, ADR
 * 0033), the owner's own Linked identity too, which is how an owner tries their own line. SMS (#1174)
 * and email (#1176) come in by this path.
 */

/** What the thread keeps of a message: files aren't downloaded, so a file alone leaves only a note. */
function textOf({ text, files }: StrangerMessage) {
  const note =
    files.length === 0
      ? ""
      : `(sent ${files.length} ${files.length === 1 ? "file" : "files"}, which wasn't kept)`;
  return [text.trim(), note].filter(Boolean).join("\n\n").slice(0, maxThreadMessageLength);
}

/**
 * Takes the core's inbound message as a Customer's, for the Representative holding its account. During
 * the owner's Ban it's dropped, as a message to their Bot is, so their line says nothing to anyone.
 */
export async function receiveStranger(
  services: Parameters<typeof receiveCustomerMessage>[0] & Pick<FeatureContext, "isUserBlocked">,
  message: StrangerMessage,
) {
  const [held] = await services.db
    .select({
      representativeId: representativeChannelAccount.representativeId,
      userId: representative.userId,
    })
    .from(representativeChannelAccount)
    .innerJoin(representative, eq(representative.id, representativeChannelAccount.representativeId))
    .where(eq(representativeChannelAccount.channelAccountId, message.account.id));
  const text = textOf(message);
  if (!held || !text || (await services.isUserBlocked(held.userId))) return;
  await receiveCustomerMessage(services, {
    representativeId: held.representativeId,
    channel: message.channel,
    externalId: message.sender.id,
    channelAccountId: message.account.id,
    proof: message.sender.verified ? { rule: "sameIdentity" } : undefined,
    message: text,
  });
}
