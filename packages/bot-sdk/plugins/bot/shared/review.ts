/** What Auto-review made of a call (spec #691). */
export type ReviewVerdictOutcome = "pass" | "block";

/** Where a blocked call's Approval stands (ADR 0024). */
export type ReviewApprovalState = "waiting" | "allowed" | "denied" | "expired";

/**
 * One Auto-review of a Bot's tool call as the client sees it: the call (`tool` and its `input`),
 * the reviewer's `summary` and `reason`, its verdict and, for a block, its Approval. It belongs to
 * a Turn (`turnId`) or a Helper (`helperId`).
 */
export type BotReview = {
  id: string;
  turnId: string | null;
  helperId: string | null;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  verdict: ReviewVerdictOutcome;
  reason: string;
  state: ReviewApprovalState | null;
  deadline: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
};
