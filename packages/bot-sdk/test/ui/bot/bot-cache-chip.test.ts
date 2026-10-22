// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botClient } from "../../../plugins/bot/client/index";
import type { BotMessage, BotTurnProvenance, BotTurnStep } from "../../../plugins/bot/shared/turn";
import { BotCacheChip } from "../../../plugins/bot/ui/bot-cache-chip";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
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

describe("the cache chip in a Bot's thread", () => {
  it("shows under a Turn that sent no Message, after the last Message before its end", () => {
    render(
      providerFor(
        createElement(BotConversation, {
          botId: "b2",
          afterTurn: (turn: BotTurnProvenance) =>
            createElement(BotCacheChip, { steps: turn.steps }),
        }),
        {
          messages: {},
          plugins,
          // A fetch that never answers: the seeded data is all the thread shows.
          fetch: vi.fn(async () => new Promise<Response>(() => {})),
          seed: (queryClient, client) =>
            queryClient.setQueryData(client.orpc.bot.get.queryKey({ input: { botId: "b2" } }), {
              bot: {
                id: "b2",
                name: "Ada",
                model: "openai:gpt-5.6",
                createdAt,
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
