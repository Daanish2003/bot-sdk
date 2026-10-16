/** One Model's 👍 and 👎 Ratings over the window, as `sdk.plugin("assistant").ratingTotals` returns them. */
export type RatingTotal = { model: string; up: number; down: number };

/** One row of the Admin's Ratings section: a Model's 👍, 👎 and share of 👎 (spec #277). */
export type RatingRow = RatingTotal & {
  /** The share of Ratings that are 👎, rounded to a whole percent. */
  downPercent: number;
};

/** The Ratings section's rows: one per Model, ordered by Model name. */
export function ratingRows(totals: RatingTotal[]): RatingRow[] {
  return totals
    .map((total) => ({
      ...total,
      downPercent: Math.round((total.down * 100) / (total.up + total.down)),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
}
