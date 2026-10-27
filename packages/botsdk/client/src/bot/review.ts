import { z } from "zod";

/** What Auto-review made of a call (spec #691). */
export type ReviewVerdictOutcome = "pass" | "block";

/** How long a blocked call waits for the user's Approval (ADR 0024). */
export const approvalWaitMs = 15_000;

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

/**
 * A blocked call's Approval in the thread (spec #761), the Rich control of kind `review_approval`:
 * it holds only the review's id, and its state is read from the review's row.
 */
export const reviewApprovalSchema = z.object({
  kind: z.literal("review_approval"),
  reviewId: z.string(),
});

export type ReviewApproval = z.infer<typeof reviewApprovalSchema>;
