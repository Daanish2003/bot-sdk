/*
 * What a Representative's reply carries beside its text (ticket #1260): its kind, and the sources it
 * rests on, which code checks and the Customer never sees. Kinds in `sourceFreeKinds` state no
 * business information, so they need no source.
 */

export const replyKinds = ["answer", "small_talk", "handoff"] as const;
export type ReplyKind = (typeof replyKinds)[number];

export const sourceFreeKinds: readonly ReplyKind[] = ["small_talk", "handoff"];

/** The fixed message code sends when it hands off (ticket #1261): no Model's kind, so none can claim it. */
export const codeHandOffKind = "code_handoff";

/** What a reply stored in a thread can be. */
export type StoredReplyKind = ReplyKind | typeof codeHandOffKind;

/** A Published fact by its key, or a Bot's result by its Assignment and an exact quote from it. */
export type ReplySource =
  | { type: "fact"; key: string }
  | { type: "assignment"; assignmentId: string; quote: string };
