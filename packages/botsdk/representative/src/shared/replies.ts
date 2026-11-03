/*
 * What a Representative's reply carries beside its text (ticket #1260): its kind, and the sources it
 * rests on, which code checks and the Customer never sees. Kinds in `sourceFreeKinds` state no
 * business information, so they need no source. A `cant_confirm` reply (ticket #1263) says the
 * Representative has no source for a question, and carries that question for the owner's Gaps.
 */

export const replyKinds = ["answer", "small_talk", "handoff", "cant_confirm"] as const;
export type ReplyKind = (typeof replyKinds)[number];

export const sourceFreeKinds: readonly ReplyKind[] = ["small_talk", "handoff", "cant_confirm"];

/**
 * What an owner reads beside a reply (ticket #1262): its kind and the sources code checked. Code
 * proved each source exists, not that the paraphrase of it is right. A reply stored before kinds
 * has a null kind and no sources.
 */
export type ReplyProof = { kind: ReplyKind | null; sources: ReplySource[] };

/**
 * A Published fact by its key, a Bot's result by its Assignment and an exact quote from it, or an
 * exact quote from a document of the Release (ticket #1266).
 */
export type ReplySource =
  | { type: "fact"; key: string }
  | { type: "assignment"; assignmentId: string; quote: string }
  | { type: "document"; name: string; quote: string };
