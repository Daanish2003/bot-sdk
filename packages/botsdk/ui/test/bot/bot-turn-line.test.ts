// @vitest-environment jsdom
import type { BotMessage, BotTurnProvenance, BotTurnStep } from "@botsdk/client/bot/turn";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotTurnLine } from "../../src/bot/bot-turn-line";
import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const show = (steps: BotTurnStep[]) =>
  render(providerFor(createElement(BotTurnLine, { steps }), { messages: {} }));

const section = (name: string, tokens: number, hash: string, was?: string) => ({
  name,
  tokens,
  hash,
  ...(was ? { was } : {}),
});

/** A Step that read the first 800 of its 1000 tokens, wrote 100 and left 100 uncached. */
const warm: BotTurnStep = {
  id: "s1",
  kind: "turn",
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

describe("BotTurnLine", () => {
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

  it("turns amber on a section that changed when it should not have, with old and new hash", () => {
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
    expect(chip.className).toContain("text-amber-500");
    expect(chip.className).not.toContain("red");
    fireEvent.click(chip);

    expect(screen.getByText("rules · Cache miss (a bug)")).toBeTruthy();
    expect(screen.getByText("#oooooo → #bbbbbb")).toBeTruthy();
    expect(screen.getByText(/^A bug: rules changed/).className).toContain("text-amber-500");
  });

  it("calls a change after a new Prompt start expected, and keeps the chip calm", () => {
    show([{ ...warm, changed: { section: "first_message", kind: "expected" } }]);

    const chip = screen.getByRole("button", { name: /^Cache 80%/ });
    expect(chip.className).not.toContain("text-amber-500");
    fireEvent.click(chip);

    expect(screen.getByText(/^Expected: first_message changed/)).toBeTruthy();
  });

  it("adds a mid-Turn summary call to the cost, as a line of its own, not a Step", () => {
    const summary: BotTurnStep = {
      ...warm,
      id: "sum",
      kind: "summary",
      costMicros: 1500,
      sections: [],
      changed: null,
    };
    show([warm, summary, { ...warm, id: "s2", costMicros: 1000 }]);

    const chip = screen.getByRole("button", { name: "Cache 80% · 2 Steps · $0.0050" });
    fireEvent.click(chip);

    expect(screen.getByText("Summary · 80% cached · $0.0015")).toBeTruthy();
    expect(screen.getByText("Step 2 · 80% cached · $0.0010")).toBeTruthy();
  });

  it("keeps the saved items on the left and the figures on the right, wrapping on a phone", () => {
    const { container } = render(
      providerFor(
        createElement(BotTurnLine, {
          steps: [warm],
          saved: createElement("span", null, "Memory updated"),
        }),
        { messages: {} },
      ),
    );

    const line = container.querySelector("[data-turn-line]")!;
    expect(line.className).toContain("flex-wrap");
    expect(line.className).toContain("justify-between");
    expect(line.getAttribute("role")).toBe("group");
    expect(line.getAttribute("aria-label")).toBe("Turn details");
    const [left, right] = Array.from(line.children);
    expect(left!.textContent).toBe("Memory updated");
    expect(right!.textContent).toBe("Cache 80% · 1 Step · $0.0025");
  });

  it("opens one panel below the line, named by the button that controls it", () => {
    const { container } = show([warm]);
    const chip = screen.getByRole("button", { name: /^Cache 80%/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(chip.getAttribute("aria-controls")!)!;
    expect(panel.contains(screen.getByText("Step 1 · 80% cached · $0.0025"))).toBe(true);
    // Below the line, not inside it.
    expect(container.querySelector("[data-turn-line]")!.contains(panel)).toBe(false);
    fireEvent.click(chip);
    expect(document.getElementById(panel.id)).toBeNull();
  });

  it("shows only the saved items for a Turn with no Steps", () => {
    render(
      providerFor(
        createElement(BotTurnLine, {
          steps: [],
          saved: createElement("span", null, "Memory updated"),
        }),
        { messages: {} },
      ),
    );
    expect(screen.getByText("Memory updated")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cache/ })).toBeNull();
  });

  it("shows nothing for a Turn with no Steps", () => {
    const { container } = show([]);
    expect(container.innerHTML).toBe("");
  });
});

const createdAt = new Date("2026-10-20T09:00:00.000Z");
const at = (minute: number) => new Date(createdAt.getTime() + minute * 60_000);
const said = (id: string, role: BotMessage["role"], text: string, minute: number): BotMessage => ({
  id,
  role,
  text,
  createdAt: at(minute),
});
const turnAt = (id: string, minute: number, sent: boolean): BotTurnProvenance => ({
  id,
  status: sent ? "complete" : "error",
  startedAt: at(minute),
  endedAt: at(minute + 1),
  sent,
  triggers: [{ source: "user", channel: "web", routineName: null, at: at(minute) }],
  memoryChanges: null,
  skillChanges: null,
  knowledgeChanges: null,
  steps: [{ ...warm, id: `${id}-s1` }],
});

describe("the Turn line in a Bot's thread", () => {
  it("shows under a Turn that sent no Message, after the last Message before its end", () => {
    render(
      providerFor(
        createElement(BotConversation, {
          botId: "b2",
          afterTurn: (turn: BotTurnProvenance) =>
            createElement("button", { type: "button" }, `Saved in ${turn.id}`),
        }),
        {
          messages: {},
          // A fetch that never answers: the seeded data is all the thread shows.
          fetch: vi.fn(async () => new Promise<Response>(() => {})),
          seed: (queryClient, client) =>
            queryClient.setQueryData(client.orpc.bots.get.queryKey({ input: { botId: "b2" } }), {
              bot: {
                id: "b2",
                name: "Ada",
                model: "openai:gpt-6-luna",
                createdAt,
                pausedAt: null,
                turnStatus: "error" as const,
                userTurnStatus: "error" as const,
              },
              conversationId: "c1",
              messages: [
                said("m1", "user", "Hi", 0),
                said("m2", "assistant", "Hello!", 0.5),
                said("m3", "user", "Still there?", 5),
              ],
              // The second Turn failed before it sent anything.
              turns: [turnAt("t1", 0, true), turnAt("t2", 5, false)],
              summaries: [],
              warmings: [],
              lastSeq: 0,
            }),
        },
      ),
    );

    const chips = screen.getAllByRole("button", { name: /Cache 80%/ });
    expect(chips).toHaveLength(2);
    // One line per Turn: the Host's saved items on its left, the figures on its right.
    const lines = document.querySelectorAll("[data-turn-line]");
    expect(lines).toHaveLength(2);
    const saved = screen.getByRole("button", { name: "Saved in t1" });
    expect(lines[0]!.contains(saved)).toBe(true);
    expect(
      saved.compareDocumentPosition(chips[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      document
        .querySelector('[data-id="m2"]')!
        .parentElement!.nextElementSibling?.contains(chips[0]!),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-id="m3"]')!
        .parentElement!.nextElementSibling?.contains(chips[1]!),
    ).toBe(true);
  });
});
