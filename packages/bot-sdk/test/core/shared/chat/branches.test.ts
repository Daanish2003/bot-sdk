import { describe, expect, it } from "vitest";

import { siblingPosition, newestLeaf, pathTo } from "../../../../core/shared/chat/branches";

/** A Message tree node created `minute` minutes into the Conversation. */
function node(id: string, parentId: string | null, minute: number) {
  return { id, parentId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) };
}

/**
 * q1 ─ a1 ─ q2 ─ a2
 *    │     └ q2b ─ a2b
 *    └ a1b
 * q1b ─ a1c          (an edited first Message: a second root)
 */
const tree = [
  node("q1", null, 0),
  node("a1", "q1", 1),
  node("q2", "a1", 2),
  node("a2", "q2", 3),
  node("a1b", "q1", 4),
  node("q2b", "a1", 5),
  node("a2b", "q2b", 6),
  node("q1b", null, 7),
  node("a1c", "q1b", 8),
];

describe("pathTo", () => {
  it("walks from a root down to the leaf, oldest first", () => {
    expect(pathTo(tree, "a2b").map((n) => n.id)).toEqual(["q1", "a1", "q2b", "a2b"]);
  });

  it("is empty without a leaf", () => {
    expect(pathTo(tree, null)).toEqual([]);
  });

  it("is empty for a leaf that isn't in the tree", () => {
    expect(pathTo(tree, "missing")).toEqual([]);
  });
});

describe("siblingPosition", () => {
  it("counts a Message's siblings, oldest first, and names its neighbours", () => {
    expect(siblingPosition(tree, tree[1]!)).toEqual({
      index: 0,
      count: 2,
      previousId: null,
      nextId: "a1b",
    });
    expect(siblingPosition(tree, node("a1b", "q1", 4))).toEqual({
      index: 1,
      count: 2,
      previousId: "a1",
      nextId: null,
    });
  });

  it("treats the roots as siblings", () => {
    expect(siblingPosition(tree, tree[7]!)).toEqual({
      index: 1,
      count: 2,
      previousId: "q1",
      nextId: null,
    });
  });

  it("is 1 of 1 for a Message without siblings", () => {
    expect(siblingPosition(tree, tree[3]!)).toEqual({
      index: 0,
      count: 1,
      previousId: null,
      nextId: null,
    });
  });

  it("orders siblings created at the same moment by id", () => {
    const tied = [node("r", null, 0), node("b", "r", 1), node("a", "r", 1)];
    expect(siblingPosition(tied, tied[1]!)).toMatchObject({ index: 1, previousId: "a" });
  });
});

describe("newestLeaf", () => {
  it("is the newest leaf anywhere in the subtree, not the newest child's", () => {
    // a1's newest child is q2b (minute 5), but a2b (minute 6) is the newest leaf either way;
    // q1's newest child is a1b (minute 4), a leaf older than a2b.
    expect(newestLeaf(tree, "q1")).toBe("a2b");
  });

  it("is the Message itself when it has no children", () => {
    expect(newestLeaf(tree, "a1b")).toBe("a1b");
  });

  it("stays inside the subtree", () => {
    expect(newestLeaf(tree, "q2")).toBe("a2");
  });
});
