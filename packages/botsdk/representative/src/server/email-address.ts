import { eq, inArray } from "drizzle-orm";

import { newEmailAddress } from "@botsdk/bot/channel/internal";
import type { FeatureContext, StrangerEmail } from "@botsdk/bot/feature";
import { maxThreadMessageLength, type EmailAddressView } from "../shared/contract";
import { representativeEmailAddress } from "./db/schema";
import { ownedRow } from "./representatives";
import { receiveCustomerMessage } from "./thread-turns";

/*
 * A Representative's email address (ticket #1346), on the email Channel's inbound domain beside the
 * Bots' addresses. Whoever writes to it is a Customer, under the identity `email:<bare address>`: the
 * Bot rule (only the owner, with a DMARC pass) is for Bots' addresses alone. An enforcing DMARC pass
 * verifies the sender; any other mail makes an unverified Customer rather than being dropped.
 */

/** The Channel a Customer's email comes on. */
export const customerEmailChannel = "email";

type Context = Pick<FeatureContext<"channelAccounts">, "db" | "clock" | "channelAccounts">;

/**
 * The owner's Representative's address, made on the first read under its Representative's lock; null
 * when the Host has no email Channel.
 */
export async function getEmailAddress(
  { db, clock, channelAccounts }: Context,
  userId: string,
  id: string,
): Promise<EmailAddressView | null> {
  const domain = channelAccounts.emailDomain();
  if (domain === null) {
    await ownedRow(db, userId, id);
    return null;
  }
  return db.transaction(async (tx) => {
    const { name } = await ownedRow(tx, userId, id, true);
    await tx
      .insert(representativeEmailAddress)
      .values({ representativeId: id, address: newEmailAddress(name, domain), createdAt: clock() })
      .onConflictDoNothing({ target: representativeEmailAddress.representativeId });
    const [row] = await tx
      .select({ address: representativeEmailAddress.address })
      .from(representativeEmailAddress)
      .where(eq(representativeEmailAddress.representativeId, id));
    return row!;
  });
}

/** Gives the owner's Representative a new address, and the old one stops at once; null as for a read. */
export async function rotateEmailAddress(
  { db, clock, channelAccounts }: Context,
  userId: string,
  id: string,
): Promise<EmailAddressView | null> {
  const domain = channelAccounts.emailDomain();
  if (domain === null) {
    await ownedRow(db, userId, id);
    return null;
  }
  return db.transaction(async (tx) => {
    const { name } = await ownedRow(tx, userId, id, true);
    const address = newEmailAddress(name, domain);
    const [row] = await tx
      .insert(representativeEmailAddress)
      .values({ representativeId: id, address, createdAt: clock() })
      .onConflictDoUpdate({
        target: representativeEmailAddress.representativeId,
        set: { address, createdAt: clock() },
      })
      .returning({ address: representativeEmailAddress.address });
    return row!;
  });
}

/**
 * Takes a mail the core found no Bot for: false when none of its recipients is a Representative's
 * address. Otherwise its sender is a Customer of that Representative, verified only by a DMARC pass
 * under an enforcing policy.
 */
export async function receiveEmail(
  services: Parameters<typeof receiveCustomerMessage>[0],
  mail: StrangerEmail,
): Promise<boolean> {
  if (mail.to.length === 0) return false;
  const rows = await services.db
    .select({
      address: representativeEmailAddress.address,
      representativeId: representativeEmailAddress.representativeId,
    })
    .from(representativeEmailAddress)
    .where(inArray(representativeEmailAddress.address, mail.to));
  // The first recipient that is a Representative's address decides, as for a Bot's.
  for (const to of mail.to) {
    const held = rows.find((row) => row.address === to);
    if (!held) continue;
    await receiveCustomerMessage(services, {
      representativeId: held.representativeId,
      channel: customerEmailChannel,
      externalId: mail.from,
      proof: {
        rule: "dmarc",
        pass: mail.dmarc.verdict === "pass",
        policy: mail.dmarc.policy,
      },
      message: mail.text.slice(0, maxThreadMessageLength),
    });
    return true;
  }
  return false;
}
