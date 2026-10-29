import type { BotCheckIn } from "./check-in";
import type { BotHelper } from "./helper";
import type { BotReview } from "./review";
import type { BotRoutine } from "./routine";
import type { CustomRule } from "./rule";
import type { BotSecret } from "./secret";
import type { BotMessage, BotSummary, BotTurnStatus } from "./turn";

/** A Turn as a `turn` change carries it. */
export type BotTurnChange = {
  id: string;
  status: BotTurnStatus;
  startedAt: Date;
  endedAt: Date | null;
};

/** What each kind of change in a Bot's change log points at (ADR 0026). */
type BotChangeData = {
  message: BotMessage;
  turn: BotTurnChange;
  secret: BotSecret;
  rule: CustomRule;
  routine: BotRoutine;
  review: BotReview;
  helper: BotHelper;
  check_in: BotCheckIn;
  summary: BotSummary;
};

/** The kinds of change to a Bot's thread. */
export type BotChangeKind = keyof BotChangeData;

/**
 * One change to a Bot's thread, with what it points at as it is now: `data` is null once that is
 * gone (a declined Routine).
 */
export type BotChange = {
  [K in BotChangeKind]: {
    seq: number;
    kind: K;
    refId: string;
    at: Date;
    data: BotChangeData[K] | null;
  };
}[BotChangeKind];

/**
 * What `conversations.changes` returns: the changes after the cursor, oldest first, or `reload` when the log
 * no longer holds them all, so the thread must be read afresh with `bots.get`.
 */
export type BotChanges = { reload: true } | { reload: false; changes: BotChange[] };
