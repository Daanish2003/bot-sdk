import { describe, expect, it } from "vitest";

import { fuseByReciprocalRank } from "../../../../core/server/knowledge/search";

describe("fuseByReciprocalRank", () => {
  it("ranks an item found by both legs above one found by a single leg", () => {
    // b is second by meaning and first by keyword; a is only first by meaning.
    const fused = fuseByReciprocalRank(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      (item) => item,
    );

    expect(fused).toEqual(["b", "a", "c"]);
  });

  it("keeps the first appearance first when two items score the same", () => {
    expect(fuseByReciprocalRank([["x"], ["y"]], (item) => item)).toEqual(["x", "y"]);
  });

  it("keys items by the given key, so the same passage from both legs counts once", () => {
    const byMeaning = [{ id: "p1", text: "by meaning" }];
    const byKeyword = [{ id: "p1", text: "by keyword" }];

    const fused = fuseByReciprocalRank([byMeaning, byKeyword], (item) => item.id);

    expect(fused).toEqual([{ id: "p1", text: "by meaning" }]);
  });
});
