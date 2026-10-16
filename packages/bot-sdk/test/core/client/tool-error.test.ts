import { describe, expect, it } from "vitest";

import { toolErrorText } from "../../../plugins/assistant/client/tool-error";
import { createI18n } from "../../../core/shared/i18n";

const i18n = createI18n();

describe("toolErrorText", () => {
  it("shows a page's failure from its code, with the size in the locale", () => {
    expect(toolErrorText(i18n, { code: "chat.pageError.tooLarge", params: { megabytes: 2 } })).toBe(
      "The page is larger than 2 MB",
    );
  });

  it("shows a Host tool's failure with the Host's message verbatim", () => {
    expect(
      toolErrorText(i18n, { code: "chat.toolError.failed", params: { message: "Db is down" } }),
    ).toBe("The tool failed: Db is down");
  });

  it("shows a reply that ran out of tool calls from its code", () => {
    expect(toolErrorText(i18n, { code: "chat.toolError.limit" })).toBe(
      "This reply already used its tool calls",
    );
  });
});
