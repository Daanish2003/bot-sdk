/*
 * What a Representative's reply carries beside its text (ticket #1260): its kind, and the sources it
 * rests on, which code checks and the Customer never sees. Kinds in `sourceFreeKinds` state no
 * business information, so they need no source.
 */

export const replyKinds = ["answer", "small_talk", "handoff"] as const;
export type ReplyKind = (typeof replyKinds)[number];

export const sourceFreeKinds: readonly ReplyKind[] = ["small_talk", "handoff"];

/**
 * A Published fact by its key, a Bot's result by its Assignment and an exact quote from it, or an
 * exact quote from a document of the Release (ticket #1266).
 */
export type ReplySource =
  | { type: "fact"; key: string }
  | { type: "assignment"; assignmentId: string; quote: string }
  | { type: "document"; name: string; quote: string };
