import { describe, expect, it } from "vitest";

import { isFeature } from "@botsdk/bot/feature";
import { knowledge } from "../../src";

describe("the knowledge feature", () => {
  it("registers as `knowledge`, needing the Computer", () => {
    const feature = knowledge();
    expect(isFeature(feature)).toBe(true);
    expect(feature).toMatchObject({ id: "knowledge", needs: ["computer"] });
  });
});
