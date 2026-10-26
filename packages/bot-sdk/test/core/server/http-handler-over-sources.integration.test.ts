import { describe, expect, it } from "vitest";

import { createHttpHandlerOver } from "../../../core/server/over";
import { createTestSdk } from "../../support/deps";

describe("createHttpHandlerOver", () => {
  it("gives each handler its own recent-Model sources", () => {
    const sdk = createTestSdk();
    const before = sdk.recentModelSources.length;
    const options = { basePath: "/api/chat", getUser: () => null };

    createHttpHandlerOver(sdk, options);
    createHttpHandlerOver(sdk, options);

    expect(sdk.recentModelSources).toHaveLength(before);
  });
});
