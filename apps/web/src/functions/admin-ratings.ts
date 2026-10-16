import { createServerFn } from "@tanstack/react-start";

import { ratingRows, type RatingRow } from "@/admin/ratings";
import { spendRange } from "@/admin/spend";
import { adminMiddleware } from "@/middleware/admin";
import { sdk } from "@/services";

/**
 * The Admin's Ratings section (spec #277): 👍, 👎 and % 👎 per Model over the last 30 UTC days.
 * Never per user, never a rated Message. Admin only (404 otherwise).
 */
export const listRatingTotals = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async (): Promise<RatingRow[]> => {
    const totals = await sdk.admin.ratingTotals({ since: spendRange(new Date()).since });
    return ratingRows(totals);
  });
