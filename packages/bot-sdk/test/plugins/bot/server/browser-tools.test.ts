import { describe, expect, it } from "vitest";

import { type BrowserSession, browserTools, snapshotLimit } from "@botsdk/bot/bot/helpers";
import type { LoopKit } from "@botsdk/bot/bot/agent-loop";
import { maskSecrets } from "@botsdk/bot/bot/safety";

const secret = "ghp_0123456789abcdef";

describe("a Browser tool's snapshot", () => {
  it("is masked of the user's Secrets before it is cut, so a value across the cut isn't half kept", async () => {
    // The value starts 5 characters before the cut.
    const snapshot = `${"x".repeat(snapshotLimit - 5)}${secret} and more`;
    const session = { act: async () => ({ snapshot }) } as unknown as BrowserSession;
    const saved = new Map<string, string>();
    const computer = {
      writeFile: async (path: string, content: string) => saved.set(path, content),
    };
    // The loop's live call: `operate` gets the mask of the user's one Secret.
    const computerCall = (async (_name, _id, operate) =>
      operate(computer as never, {} as never, (text) =>
        maskSecrets(text, [secret]),
      )) as LoopKit["computerCall"];
    const [, snapshotTool] = browserTools(session, "bot-1", computerCall);

    const result = (await snapshotTool!.execute!({} as never, {
      toolCallId: "call-1",
      emitCustomEvent: () => {},
    })) as { snapshot: string };

    expect(result.snapshot).not.toContain(secret.slice(0, 5));
    expect(result.snapshot).toContain("***");
    for (const content of saved.values()) expect(content).not.toContain(secret);
  });
});
