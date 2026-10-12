import { describe, expect, it } from "vitest";

import { contextFill, lastRunTokens } from "../../../core/client/context-ring";

const usage = { input: 1000, output: 200, reasoning: 0, cached: 0, estimated: false };

describe("lastRunTokens", () => {
  it("takes the newest assistant Message with usage on the Branch: input plus output", () => {
    const messages = [
      { role: "user", usage: null },
      { role: "assistant", usage: { ...usage, input: 500, output: 100 } },
      { role: "user", usage: null },
      { role: "assistant", usage: { ...usage, input: 3000, output: 400 } },
      { role: "user", usage: null },
    ] as const;
    expect(lastRunTokens([...messages])).toBe(3400);
  });

  it("skips an assistant Message without usage (a Run that never reported)", () => {
    const messages = [
      { role: "assistant", usage: usage },
      { role: "user", usage: null },
      { role: "assistant", usage: null },
    ] as const;
    expect(lastRunTokens([...messages])).toBe(1200);
  });

  it("is null for a Conversation with no Run yet", () => {
    expect(lastRunTokens([{ role: "user", usage: null }])).toBeNull();
    expect(lastRunTokens([])).toBeNull();
  });
});

describe("contextFill", () => {
  it("is neutral below 80%", () => {
    expect(contextFill(7999, 10000)).toMatchObject({ level: "neutral", over: false });
  });

  it("turns amber from 80% and red from 95%", () => {
    expect(contextFill(8000, 10000)).toMatchObject({ level: "amber", over: false });
    expect(contextFill(9499, 10000)).toMatchObject({ level: "amber", over: false });
    expect(contextFill(9500, 10000)).toMatchObject({ level: "red", over: false });
  });

  it("is over once the tokens pass the window, and the ring stays full", () => {
    const fill = contextFill(12000, 10000);
    expect(fill).toMatchObject({ level: "red", over: true, percent: 120, fraction: 1 });
  });

  it("is hidden (null) when the Model's window is unknown", () => {
    expect(contextFill(5000, null)).toBeNull();
  });

  it("is hidden (null) before any Run has reported tokens", () => {
    expect(contextFill(null, 10000)).toBeNull();
  });
});
