import { describe, expect, it } from "vitest";

import { ratingRows } from "./ratings";

describe("ratingRows", () => {
  it("shows each Model's 👍 and 👎 with the share of 👎, rounded to a whole percent", () => {
    expect(
      ratingRows([
        { model: "anthropic:claude-sonnet-5-5", up: 2, down: 1 },
        { model: "anthropic:claude-haiku-5-5", up: 0, down: 3 },
      ]),
    ).toEqual([
      { model: "anthropic:claude-haiku-5-5", up: 0, down: 3, downPercent: 100 },
      { model: "anthropic:claude-sonnet-5-5", up: 2, down: 1, downPercent: 33 },
    ]);
  });

  it("is empty when no Model has a Rating", () => {
    expect(ratingRows([])).toEqual([]);
  });
});
