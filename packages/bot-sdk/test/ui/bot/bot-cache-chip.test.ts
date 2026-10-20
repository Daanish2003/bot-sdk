// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { botClient } from "../../../plugins/bot/client/index";
import type { BotTurnStep } from "../../../plugins/bot/shared/turn";
import { BotCacheChip } from "../../../plugins/bot/ui/bot-cache-chip";
import { modelsClient } from "../../../plugins/models/client/index";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const plugins = [modelsClient(), botClient()];
const show = (steps: BotTurnStep[]) =>
  render(providerFor(createElement(BotCacheChip, { steps }), { messages: {}, plugins }));

const section = (name: string, tokens: number, hash: string, was?: string) => ({
  name,
  tokens,
  hash,
  ...(was ? { was } : {}),
});

/** A Step that read the first 800 of its 1000 tokens, wrote 100 and left 100 uncached. */
const warm: BotTurnStep = {
  id: "s1",
  inputTokens: 1000,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
  costMicros: 2500,
  sections: [
    section("tools", 400, "aaaaaaaaaaaa"),
    section("rules", 400, "bbbbbbbbbbbb"),
    section("history", 100, "cccccccccccc"),
    section("newest", 100, "dddddddddddd"),
  ],
  changed: null,
};

describe("BotCacheChip", () => {
  it("shows the hit rate, Steps and cost, and expands to the bar and the hashes", () => {
    const { container } = show([warm, { ...warm, id: "s2", costMicros: 1000 }]);

    const chip = screen.getByRole("button", { name: "Cache 80% · 2 Steps · $0.0035" });
    expect(container.querySelector("li")).toBeNull();
    fireEvent.click(chip);

    expect(screen.getByText("Step 1 · 80% cached · $0.0025")).toBeTruthy();
    expect(screen.getAllByText("tools · Read from cache")).toBeTruthy();
    expect(screen.getAllByText("history · Written to cache")).toBeTruthy();
    expect(screen.getAllByText("newest · Not cached")).toBeTruthy();
    expect(screen.getAllByText("#aaaaaa")).toHaveLength(2);
    expect(screen.queryByText(/a bug/i)).toBeNull();
  });

  it("turns red on a section that changed when it should not have, with old and new hash", () => {
    const missed: BotTurnStep = {
      ...warm,
      cacheReadTokens: 400,
      cacheWriteTokens: 500,
      sections: [
        section("tools", 400, "aaaaaaaaaaaa"),
        section("rules", 400, "bbbbbbbbbbbb", "oooooooooooo"),
        section("history", 100, "cccccccccccc"),
        section("newest", 100, "dddddddddddd"),
      ],
      changed: { section: "rules", kind: "bug" },
    };
    show([missed]);

    const chip = screen.getByRole("button", { name: "⚠ Cache miss: rules · 1 Step · $0.0025" });
    expect(chip.className).toContain("text-red-600");
    fireEvent.click(chip);

    expect(screen.getByText("rules · Cache miss (a bug)")).toBeTruthy();
    expect(screen.getByText("#oooooo → #bbbbbb")).toBeTruthy();
    expect(screen.getByText(/^A bug: rules changed/)).toBeTruthy();
  });

  it("calls a change after a new Prompt start expected, and keeps the chip calm", () => {
    show([{ ...warm, changed: { section: "first_message", kind: "expected" } }]);

    const chip = screen.getByRole("button", { name: /^Cache 80%/ });
    expect(chip.className).not.toContain("text-red-600");
    fireEvent.click(chip);

    expect(screen.getByText(/^Expected: first_message changed/)).toBeTruthy();
  });

  it("shows nothing for a Turn with no Steps", () => {
    const { container } = show([]);
    expect(container.innerHTML).toBe("");
  });
});
