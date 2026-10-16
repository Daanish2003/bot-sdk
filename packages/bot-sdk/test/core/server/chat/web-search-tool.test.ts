import { describe, expect, it, vi } from "vitest";

import { freeMeter, type SearchMeter } from "../../../../plugins/models/server/meter";
import { createToolBudget } from "../../../../plugins/assistant/server/chat/tracked-tool";
import { createWebSearchTool } from "../../../../plugins/assistant/server/chat/web-search-tool";
import { createPartsBuilder } from "../../../../plugins/assistant/shared/chat/parts";
import { createFakeSearchClient } from "../../../support/fake-search-client";

const results = [{ title: "Result", url: "https://example.test/", snippet: "A snippet" }];

function toolWith(meter: SearchMeter) {
  const searchClient = createFakeSearchClient({ results });
  const parts = createPartsBuilder();
  const tool = createWebSearchTool({
    searchClient,
    credentials: { apiKey: "tvly-key" },
    meter,
    parts,
    onChange: () => {},
    budget: createToolBudget(0),
  });
  const call = (query: string) => tool.execute!({ query }, { toolCallId: "call-1" } as never);
  return { searchClient, parts, call };
}

describe("the web_search tool's meter", () => {
  it("searches on a free meter", async () => {
    const { searchClient, call } = toolWith(freeMeter);

    await expect(call("news")).resolves.toEqual({ results });
    expect(searchClient.calls).toHaveLength(1);
  });

  it("doesn't search when the meter refuses, and records nothing", async () => {
    const record = vi.fn(async () => {});
    const refusing: SearchMeter = {
      onHost: true,
      mayRun: async () => ({ ok: false, resetsAt: new Date("2026-01-02T00:00:00Z") }),
      record,
    };
    const { searchClient, parts, call } = toolWith(refusing);

    await expect(call("news")).resolves.toMatchObject({ reason: "quota_exceeded" });
    expect(searchClient.calls).toEqual([]);
    expect(record).not.toHaveBeenCalled();
    expect(parts.parts().parts).toEqual([
      expect.objectContaining({ type: "web_search", state: "error" }),
    ]);
  });

  it("records each search that returns results", async () => {
    const record = vi.fn(async () => {});
    const { call } = toolWith({ onHost: true, mayRun: async () => ({ ok: true }), record });

    await call("news");

    expect(record).toHaveBeenCalledTimes(1);
  });
});
