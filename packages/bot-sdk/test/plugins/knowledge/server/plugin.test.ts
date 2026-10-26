import { describe, expect, it } from "vitest";

import { isFeature } from "../../../../core/server/feature";
import { knowledge } from "../../../../plugins/knowledge/server/plugin";

describe("the knowledge feature", () => {
  it("registers as `knowledge`, needing the Computer", () => {
    const feature = knowledge();
    expect(isFeature(feature)).toBe(true);
    expect(feature).toMatchObject({ id: "knowledge", needs: ["computer"] });
  });
});
