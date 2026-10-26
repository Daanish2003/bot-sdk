import { describe, expect, it } from "vitest";

import { createChatHandler } from "../../../core/server/over";
import { createTestSdk } from "../../support/deps";

describe("createChatHandler", () => {
  it("gives each handler its own recent-Model sources", () => {
    const sdk = createTestSdk();
    const before = sdk.recentModelSources.length;
    const options = { basePath: "/api/chat", getUser: () => null };

    createChatHandler(sdk, options);
    createChatHandler(sdk, options);

    expect(sdk.recentModelSources).toHaveLength(before);
  });
});
