import { z } from "zod";

/**
 * A Bot's draft waiting for the owner, in its Conversation (ticket #1195), the Rich control of kind
 * `release_approval`: a card that only links to the Representative's page, where the diff is. No
 * Channel offers an answer. `answer` is absent while it waits; a card past `expiresAt` has expired,
 * and the draft stays, ready to approve from the page. `dropped` is a Bot reset's.
 */
export const releaseApprovalSchema = z.object({
  kind: z.literal("release_approval"),
  representativeId: z.string(),
  representativeName: z.string(),
  /** Where the Host shows the Representative's page: what a Channel's link opens. */
  path: z.string(),
  expiresAt: z.string(),
  answer: z.enum(["approved", "declined", "dropped"]).optional(),
});

export type ReleaseApproval = z.infer<typeof releaseApprovalSchema>;
