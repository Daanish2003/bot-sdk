import { z } from "zod";

/**
 * A Bot's proposed Published fact waiting for the owner, in its Conversation (ticket #1264), the Rich
 * control of kind `fact_approval`: a card that only links to the Facts page, where the current and
 * proposed values are side by side. No Channel offers an answer. `answer` is absent while it waits; a
 * card past `expiresAt` has expired, and the proposal can no longer change the fact. `dropped` is a
 * Bot reset's.
 */
export const factApprovalSchema = z.object({
  kind: z.literal("fact_approval"),
  key: z.string(),
  /** Where the Host shows the Facts page: what a Channel's link opens. */
  path: z.string(),
  expiresAt: z.string(),
  /** The tool call that posted it, so a replay of that call finds its card whether or not it was answered. */
  call: z.string().optional(),
  answer: z.enum(["approved", "declined", "dropped"]).optional(),
});

export type FactApproval = z.infer<typeof factApprovalSchema>;
