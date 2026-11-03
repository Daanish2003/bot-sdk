import { z } from "zod";

/*
 * Who a message is from, as far as code will vouch (ticket #1255). A Channel's rule is data its
 * Customer path supplies with each message, as a `ChannelProof`, and a Channel with no rule proves
 * nobody. `judgeSender` decides from that and the identity's standing, and a Turn for a sender it
 * refuses gets nothing private.
 */

/** Verification lapses after this long without verified contact, because numbers get recycled. */
export const verificationLapseMs = 90 * 24 * 60 * 60_000;

/**
 * How long a passed code or signed link vouches for its identity's messages. Far shorter than the
 * lapse and never renewed, because these Channels' senders can be spoofed: after a code, a spoofed
 * number passes for this long, not for 90 days, and then the next proof is one more code.
 */
export const proofLastsMs = 60 * 60_000;

/** What a Channel says of a message's sender, under that Channel's rule. */
export const channelProof = z.discriminatedUnion("rule", [
  /** The platform authenticates the sender (Telegram, WhatsApp, Discord, Slack, Matrix). */
  z.object({ rule: z.literal("sameIdentity") }),
  /** A code sent to the number the message came from, and sent back (SMS, voice). */
  z.object({ rule: z.literal("codeRoundTrip") }),
  /** A code sent to an identity already on record, and sent back here (web chat). */
  z.object({ rule: z.literal("codeToRecord") }),
  /** The email's DMARC result and the policy of the sender's domain; a signed link otherwise. */
  z.object({
    rule: z.literal("dmarc"),
    pass: z.boolean(),
    policy: z.enum(["none", "quarantine", "reject"]),
  }),
]);
export type ChannelProof = z.infer<typeof channelProof>;

/** An identity's standing, as stored on it. */
export type IdentityStanding = {
  /** Its last verified contact; null when never verified, or lapsed. */
  verifiedContactAt: Date | null;
  /** When it lapsed; null when it hasn't, or has been verified since. */
  lapsedAt: Date | null;
};

/** Whether an identity's verification has lapsed, or would by `now`. */
export const hasLapsed = (standing: IdentityStanding, now: Date) =>
  standing.lapsedAt !== null || (standing.verifiedContactAt !== null && !isVerified(standing, now));

/** Whether an identity is verified at `now`: it had verified contact in the last 90 days. */
export const isVerified = (
  { verifiedContactAt }: Pick<IdentityStanding, "verifiedContactAt">,
  now: Date,
) =>
  verifiedContactAt !== null && now.getTime() - verifiedContactAt.getTime() < verificationLapseMs;

/**
 * Whether this message's sender is verified, and the identity's standing after it. This message's
 * proof counts, or a code or signed link passed in the last hour on a Channel that has a rule: the
 * 90-day standing never vouches for it, so spoofed mail from a verified address proves nothing, and
 * it neither takes that standing away nor keeps it from lapsing. A lapsed identity stays lapsed under
 * the same-identity rule, which can't tell the number's next holder from the last, until a code to
 * another identity on record clears it (`customer-proof.ts`).
 */
export function judgeSender(
  standing: IdentityStanding & { provenUntil: Date | null },
  proof: ChannelProof | undefined,
  now: Date,
): { verified: boolean; standing: IdentityStanding } {
  const lapsedNow = standing.verifiedContactAt !== null && !isVerified(standing, now);
  const lapsedAt = lapsedNow ? now : standing.lapsedAt;
  // A failed check on a domain that enforces it is evidence of spoofing, whatever came before.
  const forged = proof?.rule === "dmarc" && !proof.pass && proof.policy !== "none";
  const proven =
    proof !== undefined && !forged && standing.provenUntil !== null && now < standing.provenUntil;
  const verified =
    proven ||
    (proof?.rule === "dmarc"
      ? proof.pass && proof.policy !== "none"
      : proof?.rule === "sameIdentity" && lapsedAt === null);
  if (verified) return { verified, standing: { verifiedContactAt: now, lapsedAt: null } };
  return {
    verified,
    standing: { verifiedContactAt: lapsedNow ? null : standing.verifiedContactAt, lapsedAt },
  };
}
