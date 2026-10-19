import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import { BrowserSession, unreadPageNote } from "../../../../plugins/bot/server/browser-tools";
import type { ComputerHandle } from "../../../../plugins/computer/server/plugin";

describe("BrowserSession.act", () => {
  it("reports an action that happened as done, even when the page can't be read after it", async () => {
    const session = new BrowserSession(1, "bot");
    vi.spyOn(session, "open").mockResolvedValue();
    // The click navigated, so the old page's context is gone as the snapshot reads it.
    const page = {
      ariaSnapshot: async () => {
        throw new Error("Execution context was destroyed, most likely because of a navigation");
      },
      url: () => "https://shop.example/order",
      title: async () => "Order",
    } as unknown as Page;
    vi.spyOn(session, "page").mockResolvedValue(page);

    const read = await session.act({} as ComputerHandle, async () => "Clicked e3");

    expect(read).toEqual({
      result: "Clicked e3",
      snapshot: unreadPageNote(
        "Execution context was destroyed, most likely because of a navigation",
      ),
    });
  });
});
