import { describe, expect, it } from "vitest";

import { toolRows } from "../../../core/client/key-settings";

describe("toolRows", () => {
  it("lists Tavily for web search, missing until a key is saved", () => {
    expect(toolRows([])).toEqual([
      {
        id: "tavily",
        label: "Tavily",
        description: "Web search",
        status: "missing",
        hint: null,
        service: "tavily",
      },
    ]);
  });

  it("shows the saved key's hint and verified state, ignoring Provider credentials", () => {
    const [tavily] = toolRows([
      { service: "anthropic", hint: "…1234", verified: true },
      { service: "tavily", hint: "…9xQ2", verified: true },
    ]);

    expect(tavily).toMatchObject({ status: "verified", hint: "…9xQ2" });
  });
});
