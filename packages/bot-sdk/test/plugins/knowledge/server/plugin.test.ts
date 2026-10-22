import { describe, expect, it } from "vitest";

import { orderPlugins } from "../../../../core/server/plugin";
import { knowledge } from "../../../../plugins/knowledge/server/plugin";

describe("the knowledge plugin", () => {
  it("registers as `knowledge`, using the Computer", () => {
    expect(knowledge()).toMatchObject({ id: "knowledge", uses: ["computer"] });
  });

  it("comes after the computer plugin when both are enabled", () => {
    const computer = { id: "computer" };
    expect(orderPlugins([knowledge(), computer]).map((plugin) => plugin.id)).toEqual([
      "computer",
      "knowledge",
    ]);
  });
});
