import { eq, inArray } from "drizzle-orm";

import {
  headerText,
  namedAddress,
  newEmailAddress,
  replySubject,
} from "@botsdk/bot/channel/internal";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { FeatureContext, StrangerEmail } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  maxExternalIdLength,
  maxThreadMessageLength,
  type EmailAddressView,
} from "../shared/contract";
import { codeLifetimeMs } from "./customer-proof";
import { representative, representativeEmailAddress } from "./db/schema";
import { type MailContext, sendCustomerMail } from "./email-unsubscribe";
import { ownedRow } from "./representatives";
import { keepSentMail, messageIdsOf, threadMailOf } from "./thread-mail";
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
    return { address: await addressIn(tx, clock, { representativeId: id, name, domain }) };
  });
}

/** The address of the Representative, whose row `tx` holds, made now if it has none. */
async function addressIn(
  tx: Transaction,
  clock: () => Date,
  { representativeId, name, domain }: { representativeId: string; name: string; domain: string },
) {
  await tx
    .insert(representativeEmailAddress)
    .values({ representativeId, address: newEmailAddress(name, domain), createdAt: clock() })
    .onConflictDoNothing({ target: representativeEmailAddress.representativeId });
  const [row] = await tx
    .select({ address: representativeEmailAddress.address })
    .from(representativeEmailAddress)
    .where(eq(representativeEmailAddress.representativeId, representativeId));
  return row!.address;
}

/**
 * Who a Customer email is from: the Representative's name and address, made on its first mail when
 * the owner never opened it, as a code or reply goes from whichever Representative the Customer
 * reached. Thrown when the Host has no email Channel or the Representative is gone, for the caller.
 */
async function senderOf({ db, clock, channelAccounts }: MailContext, representativeId: string) {
  const domain = channelAccounts.emailDomain();
  if (domain === null) throw new Error("The Representative has no email address");
  const [found] = await db
    .select({ address: representativeEmailAddress.address, name: representative.name })
    .from(representativeEmailAddress)
    .innerJoin(representative, eq(representative.id, representativeEmailAddress.representativeId))
    .where(eq(representativeEmailAddress.representativeId, representativeId));
  if (found) return { ...found, domain };
  // Only its first mail makes one, under the Representative's row.
  const sender = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ name: representative.name })
      .from(representative)
      .where(eq(representative.id, representativeId))
      .for("key share");
    if (!row) return null;
    const address = await addressIn(tx, clock, { representativeId, name: row.name, domain });
    return { name: row.name, address, domain };
  });
  if (!sender) throw new Error("The Representative has no email address");
  return sender;
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

/** The Message-IDs a mail answers: its References, else its In-Reply-To (headers are case-insensitive). */
function referencesOf(headers: Record<string, string>): string[] {
  const named = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const references = messageIdsOf(named("references"));
  const ids = references.length > 0 ? references : messageIdsOf(named("in-reply-to"));
  return ids.filter((id) => id.length <= 998).slice(-50);
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
    // Taken and dropped: no identity can hold the address (a bounce's is empty), and a throw would
    // have the provider send it again and again.
    if (mail.from.length === 0 || mail.from.length > maxExternalIdLength) {
      services.logger.error(
        `Representative ${held.representativeId}: dropped an email whose sender address is empty or too long`,
      );
      return true;
    }
    const received = await receiveCustomerMessage(services, {
      representativeId: held.representativeId,
      channel: customerEmailChannel,
      externalId: mail.from,
      proof: {
        rule: "dmarc",
        pass: mail.dmarc.verdict === "pass",
        policy: mail.dmarc.policy,
      },
      message: mail.text.slice(0, maxThreadMessageLength),
      // Clamped, not refused: a mail's threading is never a reason to drop what the Customer wrote.
      mail: {
        messageId: mail.messageId.slice(0, 998),
        subject: mail.subject.slice(0, 998),
        references: referencesOf(mail.headers),
      },
    });
    // Taken, so the provider doesn't send it again: the Customer's limit drops it, as for any Channel.
    if (received?.limited) {
      services.logger.error(
        `Representative ${held.representativeId}: dropped an email over the Customer's inbound limit`,
      );
    }
    return true;
  }
  return false;
}

/**
 * Emails the Customer at `externalId` a signed link to open (ticket #1348), or a code to enter in a
 * web chat window (ticket #1350), from the Representative's address, as a mail of its own: it belongs
 * to no subject thread. A throw, such as the provider's, is for the caller to log.
 */
export async function sendProofEmail(
  context: MailContext,
  {
    representativeId,
    externalId,
    ...proof
  }: { representativeId: string; externalId: string } & ({ url: string } | { code: string }),
) {
  const from = await senderOf(context, representativeId);
  await sendCustomerMail(context, representativeId, {
    from: namedAddress(from.name, from.address),
    to: externalId,
    subject:
      "url" in proof
        ? `Confirm your email address with ${headerText(from.name)}`
        : `Your code for ${headerText(from.name)}`,
    text:
      "url" in proof
        ? `To confirm this email address is yours, open this link and press Confirm. It works once, and soon expires.

${proof.url}

If you didn't ask for this, ignore it.`
        : `Your code is ${proof.code}. Enter it in the chat window to confirm this email address is yours. It works once, and expires in ${codeLifetimeMs / 60_000} minutes.

If you didn't ask for this, ignore it.`,
    messageId: `<${uuidv7()}@${from.domain}>`,
  });
}

/**
 * Emails a reply to the Customer at `externalId` from the Representative's address (ticket #1347), in
 * the subject thread of their mail: "Re:" its subject, answering their latest mail, with the whole
 * chain as References. A throw, such as the provider's, is for the runner to retry.
 */
export async function sendEmail(
  context: MailContext,
  {
    representativeId,
    externalId,
    text,
  }: { representativeId: string; externalId: string; text: string },
) {
  const { db } = context;
  // Thrown, so the runner retries in case the Host adds the Channel.
  const from = await senderOf(context, representativeId);
  const thread = await threadMailOf(db, { representativeId, externalId });
  const messageId = `${uuidv7()}@${from.domain}`;
  const last = thread?.messageIds.at(-1);
  await sendCustomerMail(context, representativeId, {
    from: namedAddress(from.name, from.address),
    to: externalId,
    subject: replySubject(thread?.subject ?? "", from.name),
    text,
    messageId: `<${messageId}>`,
    ...(thread &&
      last && {
        inReplyTo: `<${last}>`,
        references: thread.messageIds.map((id) => `<${id}>`),
      }),
  });
  // After the send: a failure here retries the send, which the Customer sees twice, rather than losing the chain.
  if (thread) await db.transaction((tx) => keepSentMail(tx, thread.threadId, messageId));
}
