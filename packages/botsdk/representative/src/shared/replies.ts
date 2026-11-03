/*
 * What a Representative's reply carries beside its text (ticket #1260): its kind, and the sources it
 * rests on, which code checks and the Customer never sees. Kinds in `sourceFreeKinds` state no
 * business information, so they need no source. A `cant_confirm` reply (ticket #1263) says the
 * Representative has no source for a question, and carries that question for the owner's Gaps.
 */

export const replyKinds = ["answer", "small_talk", "handoff", "cant_confirm"] as const;
export type ReplyKind = (typeof replyKinds)[number];

export const sourceFreeKinds: readonly ReplyKind[] = ["small_talk", "handoff", "cant_confirm"];

/** A Published fact by its key, or a Bot's result by its Assignment and an exact quote from it. */
export type ReplySource =
  | { type: "fact"; key: string }
  | { type: "assignment"; assignmentId: string; quote: string };
