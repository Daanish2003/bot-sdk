import { createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { type MessagingReach, MessagingSendError, type SendProgress } from "@botsdk/bot/channel";
import type { Transaction } from "@botsdk/bot/plugin";
import { absorbCustomer } from "./customer-merge";
import { type GateRefusal, passGate, type ViaChannel } from "./outbound-gate";
import {
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeVerification,
} from "./db/schema";
import { type ChannelProofRule, hasLapsed, proofLastsMs } from "./verification";

/*
 * A Customer proves who they are with a code or a signed link (ticket #1256). The `verify_customer`
 * tool asks for one, and code alone decides whether it goes and where: to the sender on a Channel
 * whose sender can be spoofed but not reached, and otherwise only to an identity on the owner's
 * record. A message holding the code is caught before it is stored, so no prompt ever holds it.
 */

/** How long a code can be passed. */
const codeLifetimeMs = 10 * 60_000;

/** How long a signed link can be opened. Mail is slower than a text. */
const linkLifetimeMs = 60 * 60_000;

/** How many wrong codes void the sender's code: they ask for a new one. */
const maxCodeAttempts = 5;

/** Proofs a sender can ask for, and an identity can receive, in `sendLimitWindowMs`. */
const sendLimit = 5;
const sendLimitWindowMs = 60 * 60_000;

/** The Channel a web chat visitor writes from. Nothing can send to it: they read their thread. */
export const webChatChannel = "web";

/** What a Channel is given to send: a code to read back, or the token of a link to open. */
export type Proof = { kind: "code" | "link"; secret: string };

/** How messages reach a Customer; a Channel's Customer path supplies this. A throw means it didn't go. */
export type CustomerChannel = {
  send: (
    to: { channel: string; externalId: string },
    message: { text: string },
    /**
     * The Representative whose thread it's on, the account the Customer last wrote to, and what an
     * earlier attempt got out. A throw of `MessagingSendError` says how far this one got, and an
     * `AccountSendError` also which account it went through, where a retry carries on.
     */
    via: {
      representativeId: string;
      channelAccountId: string | null;
      resume: SendProgress | null;
    },
  ) => Promise<void>;
  sendProof: (to: { channel: string; externalId: string }, proof: Proof) => Promise<void>;
  /** What the platform of `channel` limits, as its adapter declares it; left out, nothing is limited. */
  reach?: (channel: string) => MessagingReach | undefined;
};

/** A send that failed partway through account `channelAccountId`, which its retry resumes on. */
export class AccountSendError extends MessagingSendError {
  readonly channelAccountId: string;

  constructor(channelAccountId: string, failed: MessagingSendError) {
    super(failed.progress, failed.cause);
    this.name = "AccountSendError";
    this.channelAccountId = channelAccountId;
  }
}

/** The Channel of whatever `context` a job or the API runs with. */
export type ChannelOf = (
  context: Pick<FeatureContext<"channelAccounts">, "db" | "keyring" | "channelAccounts">,
) => CustomerChannel;

/** A Channel that reaches nobody, for what a test Customer sends. */
export const noCustomerChannel: CustomerChannel = {
  send: async () => {},
  sendProof: async () => {},
};

/** A proof on its way, with its address. */
export type SentProof = { to: { channel: string; externalId: string }; proof: Proof };

/**
 * The tool's one answer: whether or not the claim is on record, or anything was sent at all. Any
 * other would tell a stranger who is a Customer.
 */
export const proofAnswer = {
  answer:
    "If that identity can receive a proof, one is on its way. Ask the Customer to send the code here, or to open the link, and don't say whether the identity is on record.",
};

/** The answers that depend on nothing about the claim, so they tell nobody who is a Customer. */
export const noProofAnswer = {
  answer: "Who this sender is can't be proved on this Channel, so don't ask them for a code.",
};
export const alreadyVerifiedAnswer = {
  answer: "This sender is already verified, so no proof is needed.",
};

const proofKeys = new Map<string, Buffer>();
/** Its own key under the secret, as ADR 0010's other uses of the keyring have. */
const proofKey = (secret: string) => {
  let key = proofKeys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", "botsdk representative proof", 32));
    proofKeys.set(secret, key);
  }
  return key;
};

type SignedPurpose = "code" | "link" | "widgetSession" | "unsubscribe";

export const signed = (secret: string, purpose: SignedPurpose, value: string) =>
  createHmac("sha256", proofKey(secret)).update(`${purpose}:${value}`).digest("base64url");

/**
 * Whether `actual` is `value`'s keyed hash, in base64url, under any secret of the keyring. It compares
 * the text: decoding it first would let other strings pass as the same bytes.
 */
export const signedByKeyring = (
  keyring: readonly string[],
  purpose: SignedPurpose,
  value: string,
  actual: string,
) => {
  const given = Buffer.from(actual);
  return keyring.some((secret) => {
    const expected = Buffer.from(signed(secret, purpose, value));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
};

const hashCode = (keyring: readonly string[], id: string, code: string) =>
  signed(keyring[0]!, "code", `${id}:${code}`);

/** Whether `code` is what the row's hash was made from, under any secret of the keyring. */
const isTheCode = (keyring: readonly string[], id: string, code: string, hash: string | null) =>
  hash !== null && signedByKeyring(keyring, "code", `${id}:${code}`, hash);

const linkToken = (keyring: readonly string[], id: string) =>
  `${id}.${signed(keyring[0]!, "link", id)}`;

/** Whether a code can still be passed. */
const isLive = (row: { usedAt: Date | null; expiresAt: Date; attempts: number }, now: Date) =>
  row.usedAt === null && now < row.expiresAt && row.attempts < maxCodeAttempts;

/** The identity at an address on the owner's record, with what decides whether a proof may use it. */
async function identityAt(
  tx: Transaction,
  userId: string,
  address: { channel: string; externalId: string },
) {
  const [found] = await tx
    .select({
      id: representativeCustomerIdentity.id,
      customerId: representativeCustomerIdentity.customerId,
      verifiedContactAt: representativeCustomerIdentity.verifiedContactAt,
      lapsedAt: representativeCustomerIdentity.lapsedAt,
      provenUntil: representativeCustomerIdentity.provenUntil,
      blockedAt: representativeCustomer.blockedAt,
    })
    .from(representativeCustomerIdentity)
    .innerJoin(
      representativeCustomer,
      eq(representativeCustomer.id, representativeCustomerIdentity.customerId),
    )
    .where(
      and(
        eq(representativeCustomerIdentity.userId, userId),
        eq(representativeCustomerIdentity.channel, address.channel),
        eq(representativeCustomerIdentity.externalId, address.externalId),
      ),
    );
  return found;
}

/**
 * Holds these identities in id order, so two senders claiming each other can't deadlock, and the
 * owner's correction of an address can't pass a proof on its way to the old one.
 */
export async function holdIdentities(tx: Transaction, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await tx
      .select({ id: representativeCustomerIdentity.id })
      .from(representativeCustomerIdentity)
      .where(eq(representativeCustomerIdentity.id, id))
      .for("update");
  }
}

/** Whether a Customer has just this one identity: a stranger, with nothing a proof could open. */
async function isOnlyIdentity(tx: Transaction, customerId: string) {
  const identities = await tx
    .select({ id: representativeCustomerIdentity.id })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.customerId, customerId))
    .limit(2);
  return identities.length === 1;
}

/**
 * Makes a proof for this Turn's sender, if one should go, for the caller to send once it commits.
 * A sender whose number or address can be reached proves themselves by it, whatever the Model
 * claims, unless their verification has lapsed: that number's next holder would get the code. A
 * sender gets a code by way of another identity of their own Customer. Only one who hasn't lapsed and
 * whose Customer has no other identity can use any identity on record, since passing a code opens
 * what their Customer holds, and a new holder could make an identity of their own and claim it. A lapsed identity or a blocked Customer's receives none.
 * So a Customer with one identity and a lapse has no way back but the owner. A verified sender has
 * nothing to prove, so one goes only for a claim on another Customer, which links their Channel
 * (ticket #1257). Not from a Channel whose sender can be spoofed, though: an hour's vouching for a
 * number is too little to hand its whole history to whoever holds the identity claimed, so such a
 * sender is linked from the other side, or by the owner. A claim that leads nowhere leaves a code
 * nobody can pass, unless a real one is on its way, so that what the sender types next is treated
 * just as it is after a claim on record.
 */
export async function requestProof(
  tx: Transaction,
  {
    keyring,
    userId,
    thread: { threadId, heard, verified, proofRule, releaseId, refusals },
    claimed,
    now,
    channel,
  }: {
    keyring: readonly string[];
    userId: string;
    thread: {
      threadId: string;
      heard: { channel: string; externalId: string };
      verified: boolean;
      proofRule: ChannelProofRule | null;
      releaseId?: string | null;
      refusals?: GateRefusal[];
    };
    claimed: { channel: string; externalId: string } | null;
    now: Date;
    channel: Pick<CustomerChannel, "reach">;
  },
): Promise<SentProof | null> {
  if (!proofRule || (verified && !claimed)) return null;
  // As for a reply: a Turn that began before the owner took over or blocked sends nothing more.
  const [held] = await tx
    .select({ state: representativeThread.state })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId));
  if (held?.state !== "representative") return null;
  const before = await identityAt(tx, userId, heard);
  // The owner has corrected this address since the message came.
  if (!before) return null;
  const claim = claimed ? await identityAt(tx, userId, claimed) : undefined;
  await holdIdentities(tx, [before.id, ...(claim ? [claim.id] : [])]);
  // Read again under the hold: either may have changed while waiting for it.
  const sender = await identityAt(tx, userId, heard);
  if (sender?.id !== before.id) return null;
  // The gate logs why a blocked Customer gets nothing.
  if (sender.blockedAt !== null) {
    await passGate(tx, { kind: "proof", threadId, to: heard, now, releaseId, refusals, channel });
    return null;
  }
  // They passed a code while this Turn ran.
  if (!verified && sender.provenUntil !== null && now < sender.provenUntil) return null;
  const found = claimed && claim ? await identityAt(tx, userId, claimed) : undefined;
  const reachesSender = proofRule === "codeRoundTrip" || proofRule === "dmarc";
  const lapsed = hasLapsed(sender, now);
  let target: { id: string; channel: string; externalId: string } | null = null;
  if (reachesSender && !lapsed && !verified) {
    target = { id: sender.id, ...heard };
  } else if (
    claimed &&
    claimed.channel !== webChatChannel &&
    claim &&
    found?.id === claim.id &&
    found.id !== sender.id &&
    !hasLapsed(found, now) &&
    (found.customerId === sender.customerId
      ? !verified
      : !lapsed && !reachesSender && (await isOnlyIdentity(tx, sender.customerId)))
  ) {
    target = { id: found.id, ...claimed };
  }

  const { senderIdentityId, targetIdentityId, createdAt } = representativeVerification;
  const windowStart = new Date(now.getTime() - sendLimitWindowMs);
  await tx
    .delete(representativeVerification)
    .where(
      and(
        or(eq(senderIdentityId, sender.id), eq(targetIdentityId, target?.id ?? sender.id)),
        lte(createdAt, windowStart),
      ),
    );
  const askedBySender = await tx
    .select({ id: representativeVerification.id })
    .from(representativeVerification)
    .where(and(eq(senderIdentityId, sender.id), gt(createdAt, windowStart)));
  if (askedBySender.length >= sendLimit) return null;
  // Others' claims of an identity have their own count, so they can't use up its holder's own codes.
  // Someone spoofing the holder's own number can: on those Channels nothing tells the two apart.
  if (target && target.id !== sender.id) {
    const sentToTarget = await tx
      .select({ id: representativeVerification.id })
      .from(representativeVerification)
      .where(
        and(
          eq(targetIdentityId, target.id),
          ne(senderIdentityId, target.id),
          gt(createdAt, windowStart),
        ),
      );
    if (sentToTarget.length >= sendLimit) target = null;
  }

  // Before a code is made: one the gate refuses goes to nobody, as one with no target does.
  if (target) {
    const customerId = target.id === sender.id ? sender.customerId : found!.customerId;
    // So a block lands before the gate reads it or after this commits. Not waited for: the owner's
    // changes hold a Customer and then its identities, and these are held already. With one under way
    // nothing goes, and the Customer asks again.
    const [customer] = await tx
      .select({ id: representativeCustomer.id })
      .from(representativeCustomer)
      .where(eq(representativeCustomer.id, customerId))
      .for("share", { skipLocked: true });
    const decision =
      customer &&
      (await passGate(tx, {
        kind: "proof",
        threadId,
        to: { channel: target.channel, externalId: target.externalId },
        now,
        releaseId,
        refusals,
        customerId,
        channel,
      }));
    if (decision?.outcome !== "send") target = null;
  }

  if (!target) {
    const [newest] = await tx
      .select({
        usedAt: representativeVerification.usedAt,
        expiresAt: representativeVerification.expiresAt,
        attempts: representativeVerification.attempts,
      })
      .from(representativeVerification)
      .where(eq(senderIdentityId, sender.id))
      .orderBy(desc(createdAt), desc(representativeVerification.id))
      .limit(1);
    if (newest && isLive(newest, now)) return null;
  }

  const id = uuidv7();
  const isLink = target !== null && proofRule === "dmarc" && target.id === sender.id;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await tx.insert(representativeVerification).values({
    id,
    senderIdentityId: sender.id,
    targetIdentityId: target?.id ?? sender.id,
    kind: isLink ? "link" : "code",
    // Going nowhere, it hashes what no message's six digits can be.
    codeHash: isLink ? null : hashCode(keyring, id, target ? code : "none"),
    expiresAt: new Date(now.getTime() + (isLink ? linkLifetimeMs : codeLifetimeMs)),
    createdAt: now,
  });
  if (!target) return null;
  return {
    to: { channel: target.channel, externalId: target.externalId },
    proof: isLink
      ? { kind: "link", secret: linkToken(keyring, id) }
      : { kind: "code", secret: code },
  };
}

/** What stands in a thread for a message that held a code. Fixed text, so no digit of it survives. */
const codeNotes = {
  passed: "(The system hid a verification code here. It was correct.)",
  wrong: "(The system hid a verification code here. It was wrong.)",
  dead: "(The system hid a verification code here. It can't be used now, so a new one is needed.)",
};

/** How many of a message's digits are looked through for a code it holds in some other form. */
const digitsLookedAt = 64;

/** How many of a Customer's recent codes a message is checked against. */
const codesLookedAt = 20;

const digitRuns = /\d(?:[ .\-\u2013\u2014]?\d)*/g;
const onlyACode = /^\s*\d(?:[ .\-\u2013\u2014]?\d){5}\s*$/;

/** `text` with every script's decimal digits as ASCII ones, each block running from 0 up in tens. */
function withPlainDigits(text: string) {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, (digit) => {
    const at = digit.codePointAt(0)!;
    let zero = at;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    return String((at - zero) % 10);
  });
}

/** The six-digit codes in a message, however they are spaced, and whether it is nothing but one. */
function codesIn(text: string) {
  const normal = withPlainDigits(text);
  const candidates = (normal.match(digitRuns) ?? [])
    .map((run) => run.replace(/\D/g, ""))
    .filter((run) => run.length === 6);
  return { candidates, alone: onlyACode.test(normal) };
}

/** A message's digits, as ASCII ones. Six of them could be a code. */
const digitsIn = (text: string) => withPlainDigits(text).replace(/\D/g, "");

/** Whether `text` could hold a code, so that catching it could merge its sender's Customer. */
export const mayHoldCode = (text: string) => digitsIn(text).length >= 6;

/** The Customer that a code just passed by this sender would merge theirs into, if any is live. */
export async function customerProofLeadsTo(tx: Transaction, identityId: string, now: Date) {
  const [newest] = await tx
    .select({
      customerId: representativeCustomerIdentity.customerId,
      kind: representativeVerification.kind,
      usedAt: representativeVerification.usedAt,
      expiresAt: representativeVerification.expiresAt,
      attempts: representativeVerification.attempts,
    })
    .from(representativeVerification)
    .innerJoin(
      representativeCustomerIdentity,
      eq(representativeCustomerIdentity.id, representativeVerification.targetIdentityId),
    )
    .where(eq(representativeVerification.senderIdentityId, identityId))
    .orderBy(desc(representativeVerification.createdAt), desc(representativeVerification.id))
    .limit(1);
  return newest?.kind === "code" && isLive(newest, now) ? newest.customerId : undefined;
}

type MergeServices = Pick<FeatureContext, "clock" | "jobs" | "keyring"> & ViaChannel;

/**
 * Merges the sender's Customer into that of the identity their code went to, when that is another:
 * passing it proves they hold that identity (ticket #1257). What held when it was sent must hold
 * still, as `requestProof` asks it: false, proving nothing, when it doesn't.
 */
async function mergeIntoTarget(
  services: MergeServices,
  tx: Transaction,
  {
    senderId,
    customerId,
    targetId,
    now,
  }: { senderId: string; customerId: string; targetId: string; now: Date },
) {
  const identity = representativeCustomerIdentity;
  const [leadsTo] = await tx
    .select({ customerId: identity.customerId })
    .from(identity)
    .where(eq(identity.id, targetId));
  if (!leadsTo) return false;
  if (leadsTo.customerId === customerId) return true;
  // `holdSendersCustomer` holds both unless the proof's target has moved since. Waiting for another
  // now, with the identity held and out of order, could deadlock, so the code goes instead.
  const held = await tx
    .select({ id: representativeCustomer.id })
    .from(representativeCustomer)
    .where(inArray(representativeCustomer.id, [customerId, leadsTo.customerId]))
    .for("update", { skipLocked: true });
  if (held.length !== 2) return false;
  const read = (id: string) =>
    tx
      .select({
        userId: identity.userId,
        customerId: identity.customerId,
        verifiedContactAt: identity.verifiedContactAt,
        lapsedAt: identity.lapsedAt,
        blockedAt: representativeCustomer.blockedAt,
      })
      .from(identity)
      .innerJoin(representativeCustomer, eq(representativeCustomer.id, identity.customerId))
      .where(eq(identity.id, id));
  const [target] = await read(targetId);
  const [sender] = await read(senderId);
  if (
    !target ||
    !sender ||
    target.userId !== sender.userId ||
    target.blockedAt !== null ||
    hasLapsed(target, now) ||
    hasLapsed(sender, now) ||
    !(await isOnlyIdentity(tx, customerId))
  ) {
    return false;
  }
  await absorbCustomer(services, tx, {
    userId: sender.userId,
    absorbedId: customerId,
    survivorId: target.customerId,
    how: "code",
  });
  return true;
}

/** The sender's identity, now proved: what its next messages get for an hour, and its lapse ended. */
const proved = (identityId: string, now: Date, tx: Transaction) =>
  tx
    .update(representativeCustomerIdentity)
    .set({
      verifiedContactAt: now,
      lapsedAt: null,
      provenUntil: new Date(now.getTime() + proofLastsMs),
    })
    .where(eq(representativeCustomerIdentity.id, identityId));

/**
 * What to store for a Customer's message, which is the message itself unless it holds a code: then a
 * note, and the sender's correct code proves the identity. Every six digits in a message is one try,
 * and only the tries left are looked at, so a message full of guesses gets no more than five guesses
 * would; a wrong one in a sentence stays in it, as an order number would. A blocked Customer's code
 * proves nothing and spends nothing, though it is hidden all the same.
 *
 * Any other code of this Customer's found in the message, in whatever form or from whichever of their
 * identities, is hidden too and voided: this looks at many digits for no try, so telling a sender it
 * found one without ending that code would be a free guess at it, for anyone spoofing the identity.
 */
export async function catchCode(
  tx: Transaction,
  {
    services,
    identityId,
    customerId,
    blocked,
    text,
    now,
  }: {
    services: MergeServices;
    identityId: string;
    customerId: string;
    blocked: boolean;
    text: string;
    now: Date;
  },
): Promise<string> {
  const { keyring } = services;
  const digits = digitsIn(text).slice(0, digitsLookedAt);
  if (digits.length < 6) return text;
  const { candidates, alone } = codesIn(text);
  // The identity before its verification, the order the owner's edit takes them in.
  await tx
    .select({ id: representativeCustomerIdentity.id })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.id, identityId))
    .for("update");
  const [newest] = await tx
    .select()
    .from(representativeVerification)
    .where(eq(representativeVerification.senderIdentityId, identityId))
    .orderBy(desc(representativeVerification.createdAt), desc(representativeVerification.id))
    .limit(1)
    .for("update");
  if (newest?.kind === "code" && candidates.length > 0) {
    const live = isLive(newest, now);
    const tried = candidates.slice(0, live ? maxCodeAttempts - newest.attempts : maxCodeAttempts);
    if (tried.some((code) => isTheCode(keyring, newest.id, code, newest.codeHash))) {
      if (!live || blocked) return codeNotes.dead;
      await tx
        .update(representativeVerification)
        .set({ usedAt: now })
        .where(eq(representativeVerification.id, newest.id));
      const merged = await mergeIntoTarget(services, tx, {
        senderId: identityId,
        customerId,
        targetId: newest.targetIdentityId,
        now,
      });
      if (!merged) return codeNotes.dead;
      await proved(identityId, now, tx);
      return codeNotes.passed;
    }
    if (live && !blocked) {
      await tx
        .update(representativeVerification)
        .set({ attempts: newest.attempts + tried.length })
        .where(eq(representativeVerification.id, newest.id));
      if (alone) return codeNotes.wrong;
    }
  }
  const customerIdentities = tx
    .select({ id: representativeCustomerIdentity.id })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.customerId, customerId));
  const codes = await tx
    .select({ id: representativeVerification.id, codeHash: representativeVerification.codeHash })
    .from(representativeVerification)
    .where(
      and(
        eq(representativeVerification.kind, "code"),
        or(
          inArray(representativeVerification.senderIdentityId, customerIdentities),
          inArray(representativeVerification.targetIdentityId, customerIdentities),
        ),
      ),
    )
    .orderBy(desc(representativeVerification.createdAt))
    .limit(codesLookedAt);
  const windows = Array.from({ length: digits.length - 5 }, (_, at) => digits.slice(at, at + 6));
  const held = codes.find((row) =>
    windows.some((code) => isTheCode(keyring, row.id, code, row.codeHash)),
  );
  if (!held) return text;
  await tx
    .update(representativeVerification)
    .set({ usedAt: now })
    .where(
      and(eq(representativeVerification.id, held.id), isNull(representativeVerification.usedAt)),
    );
  return codeNotes.dead;
}

/**
 * Removes the proofs of a thread's Customer that can't be passed or counted any more, so a stranger
 * who never asks again leaves no record of what they claimed.
 */
export async function pruneProofs(tx: Transaction, threadId: string, now: Date) {
  const identities = tx
    .select({ id: representativeCustomerIdentity.id })
    .from(representativeCustomerIdentity)
    .innerJoin(
      representativeThread,
      eq(representativeThread.customerId, representativeCustomerIdentity.customerId),
    )
    .where(eq(representativeThread.id, threadId));
  await tx
    .delete(representativeVerification)
    .where(
      and(
        lte(representativeVerification.createdAt, new Date(now.getTime() - sendLimitWindowMs)),
        or(
          inArray(representativeVerification.senderIdentityId, identities),
          inArray(representativeVerification.targetIdentityId, identities),
        ),
      ),
    );
}

/** Ends every proof that was sent to, or asked for by, an identity whose address has changed. */
export async function voidProofs(tx: Transaction, identityId: string) {
  await tx
    .delete(representativeVerification)
    .where(
      or(
        eq(representativeVerification.senderIdentityId, identityId),
        eq(representativeVerification.targetIdentityId, identityId),
      ),
    );
}

/**
 * Opens a signed link, proving the email identity it was sent to, once. False for anything else, a
 * forged, expired, used or replaced link alike, and for a blocked Customer's.
 */
export async function openProofLink(
  { db, keyring, clock }: Pick<FeatureContext, "db" | "keyring" | "clock">,
  token: string,
): Promise<boolean> {
  const [rawId, signature, extra] = token.split(".");
  const id = z.uuid().safeParse(rawId);
  if (!id.success || signature === undefined || extra !== undefined) return false;
  if (!signedByKeyring(keyring, "link", id.data, signature)) return false;
  const now = clock();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ sender: representativeVerification.senderIdentityId })
      .from(representativeVerification)
      .where(eq(representativeVerification.id, id.data));
    if (!row) return false;
    // The identity before its verification, the order the owner's edit takes them in.
    await tx
      .select({ id: representativeCustomerIdentity.id })
      .from(representativeCustomerIdentity)
      .where(eq(representativeCustomerIdentity.id, row.sender))
      .for("update");
    const [newest] = await tx
      .select()
      .from(representativeVerification)
      .where(eq(representativeVerification.senderIdentityId, row.sender))
      .orderBy(desc(representativeVerification.createdAt), desc(representativeVerification.id))
      .limit(1)
      .for("update");
    if (
      newest?.id !== id.data ||
      newest.kind !== "link" ||
      newest.usedAt !== null ||
      now >= newest.expiresAt
    ) {
      return false;
    }
    const [customer] = await tx
      .select({ blockedAt: representativeCustomer.blockedAt })
      .from(representativeCustomerIdentity)
      .innerJoin(
        representativeCustomer,
        eq(representativeCustomer.id, representativeCustomerIdentity.customerId),
      )
      .where(eq(representativeCustomerIdentity.id, row.sender));
    if (customer?.blockedAt !== null) return false;
    await tx
      .update(representativeVerification)
      .set({ usedAt: now })
      .where(eq(representativeVerification.id, id.data));
    await proved(row.sender, now, tx);
    return true;
  });
}

const page = (status: number, body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Verify</title>${body}`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

const linkPath = "/representative/verify/:token";

/**
 * The signed link's page. Opening it asks for a click, and only the click proves anything: a mail
 * scanner that follows every link in a spoofed sender's message must not verify that sender.
 */
export const proofLinkRoutes: PublicRoute[] = [
  {
    method: "GET",
    path: linkPath,
    handle: async () =>
      page(
        200,
        '<p>Confirm that this is your email address.</p><form method="post"><button>Confirm</button></form>',
      ),
  },
  {
    method: "POST",
    path: linkPath,
    handle: async (_request, { context, params }) =>
      (await openProofLink(context, params.token ?? ""))
        ? page(200, "<p>Thanks, you're verified. You can go back to your conversation.</p>")
        : page(410, "<p>This link has expired or has already been used.</p>"),
  },
];
