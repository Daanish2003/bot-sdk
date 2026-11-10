import type { StrangerMessage } from "@botsdk/bot/feature";
import { eq } from "drizzle-orm";

import { representativeChannelAccount } from "./db/schema";
import { maxThreadMessageLength } from "../shared/contract";
import type { ChannelProof } from "./verification";
import { smsChannel } from "./customer-proof";
import { customerMessage, receiveCustomerMessage } from "./thread-turns";

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
 * What the Channel says of the sender: the platform's word when it vouches for senders, and on SMS,
 * where numbers are spoofed, a code to the number and back (#1359). Any other Channel proves nobody.
 */
function proofOf({ channel, sender }: StrangerMessage): ChannelProof | undefined {
  // A number can be spoofed, whatever the adapter says, so SMS never takes the platform's word.
  if (channel === smsChannel) return { rule: "codeRoundTrip" };
  return sender.verified ? { rule: "sameIdentity" } : undefined;
}

/** Takes the core's inbound message as a Customer's, for the Representative holding its account. */
export async function receiveStranger(
  services: Parameters<typeof receiveCustomerMessage>[0],
  message: StrangerMessage,
) {
  const [held] = await services.db
    .select({ representativeId: representativeChannelAccount.representativeId })
    .from(representativeChannelAccount)
    .where(eq(representativeChannelAccount.channelAccountId, message.account.id));
  const text = textOf(message);
  if (!held || !text) return;
  const given = {
    representativeId: held.representativeId,
    channel: message.channel,
    externalId: message.sender.id,
    channelAccountId: message.account.id,
    proof: proofOf(message),
    message: text,
  };
  // It can never be stored, so it is dropped here: a throw would have the platform send it again.
  const parsed = customerMessage.safeParse(given);
  if (!parsed.success) {
    // Which fields and why, never their values: those are the message and the sender's address.
    const issues = parsed.error.issues.map(({ path, code }) => `${path.join(".")}: ${code}`);
    services.logger.error(
      `A ${message.channel} message that can't be stored was dropped (${issues.join(", ")})`,
    );
    return;
  }
  await receiveCustomerMessage(services, given);
}
