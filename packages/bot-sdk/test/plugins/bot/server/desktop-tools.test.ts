import { describe, expect, it, vi } from "vitest";

import { desktopTools } from "../../../../plugins/bot/server/desktop-tools";
import type { LoopKit } from "../../../../plugins/bot/server/loop";

describe("the Desktop tool", () => {
  it("replays its recorded screenshot without asking again whether the Model can see", async () => {
    // A replay: the call's Checkpoint holds its result, so nothing runs live.
    const replayed = (async () => ({
      result: "screenshot",
      screenshotId: "0199f000-0000-7000-8000-000000000001",
    })) as unknown as LoopKit["computerCall"];
    // Since the call was recorded, the Model changed to one that can't see.
    const canSee = vi.fn(async () => false);
    const keep = vi.fn(async () => "never");
    const [desktop] = desktopTools(1, replayed, canSee, keep);

    const parts = await desktop!.execute!(
      { action: "screenshot" },
      { toolCallId: "call-1", emitCustomEvent: () => {} },
    );

    // The recorded screenshot's ref, read from the blob store only when the Model is called.
    expect(parts).toEqual([
      { type: "text", content: JSON.stringify({ result: "screenshot" }) },
      {
        type: "image",
        source: {
          type: "url",
          value: "screenshot:0199f000-0000-7000-8000-000000000001",
          mimeType: "image/png",
        },
      },
    ]);
    expect(canSee).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });
});
