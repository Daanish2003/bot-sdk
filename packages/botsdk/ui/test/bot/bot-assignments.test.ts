// @vitest-environment jsdom
import type { BotAssignment } from "@botsdk/client/bot/assignment";
import type { BotMessage, BotTurnProvenance } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { tasksOf } from "./fake-tasks";

afterEach(() => {
  cleanup();
});

const createdAt = new Date("2026-10-19T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

const draft = (fields: Partial<BotAssignment> = {}): BotAssignment => ({
  id: "a1",
  title: "Draft the post",
  instructions: "Write 100 words about the launch.",
  status: "working",
  result: null,
  assignerBotId: "b1",
  assignerName: "Scout",
  assignerTrusted: true,
  parent: null,
  children: [],
  budget: {
    calls: 3,
    callLimit: 30,
    costMicros: 120_000,
    moneyLimitMicros: 1_000_000,
    overBudget: false,
  },
  overdueAt: null,
  createdAt,
  endedAt: null,
  afterMessageId: null,
  log: [],
  ...fields,
});

/** A stand-in for the server's routers, with the Assignments a test gives it. */
function mount(
  messages: BotMessage[],
  assignments: BotAssignment[],
  turns: BotTurnProvenance[] = [],
  cancelled: string[] = [],
  raised: unknown[] = [],
) {
  const router = {
    bots: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns })),
      tasks: os.handler(() => tasksOf({ assignments })),
    },
    assignments: {
      list: os.input(z.object({ botId: z.string() })).handler(() => assignments),
      raiseLimit: os.input(z.unknown()).handler(({ input }) => {
        raised.push(input);
      }),
      cancel: os
        .input(z.object({ botId: z.string(), assignmentId: z.string() }))
        .handler(({ input }) => {
          cancelled.push(input.assignmentId);
        }),
    },
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    checkIns: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }),
  );
}

describe("an Assignment in its Bot's Conversation", () => {
  it("shows as a collapsed item after the Message before it, opening to the work", async () => {
    const { container } = mount(
      [said("m1", "user", "Hello"), said("m2", "assistant", "Hi"), said("m3", "user", "Thanks")],
      [draft({ afterMessageId: "m2" })],
    );

    const toggle = await screen.findByRole("button", { name: /^Assignment from/ });
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-assignment]"),
    ].map((row) => (row.dataset.assignment ? `assignment:${row.dataset.status}` : row.textContent));
    expect(rows).toEqual(["Hello", "Hi", "assignment:working", "Thanks"]);
    expect(toggle.textContent).toContain("Scout");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Write 100 words about the launch.")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Write 100 words about the launch.")).toBeTruthy();
  });

  it("comes first when no Message came before it, and shows its result once ended", async () => {
    const { container } = mount(
      [said("m1", "assistant", "Done, and told Scout.")],
      [
        draft({
          status: "failed",
          endedAt: createdAt,
          result: { outcome: "No access to the CMS." },
        }),
      ],
    );

    const toggle = await screen.findByRole("button", { name: /^Assignment from/ });
    const first = container.querySelector("[data-assignment], [data-bot-message]") as HTMLElement;
    expect(first.dataset.assignment).toBe("a1");

    fireEvent.click(toggle);
    expect(screen.getByText("No access to the CMS.")).toBeTruthy();
  });

  it("follows the rest while the Message before it isn't shown yet", async () => {
    const { container } = mount(
      [said("m1", "user", "Hello")],
      [draft({ afterMessageId: "not-shown" })],
    );

    await screen.findByRole("button", { name: /^Assignment from/ });
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-assignment]"),
    ].map((row) => row.dataset.assignment ?? row.textContent);
    expect(rows).toEqual(["Hello", "a1"]);
  });

  it("gives its Turn no Routine divider", async () => {
    const started = new Date(createdAt.getTime() + 1);
    const { container } = mount(
      [said("m1", "assistant", "On it.")],
      [draft()],
      [
        {
          id: "t1",
          status: "complete",
          startedAt: createdAt,
          endedAt: started,
          triggers: [
            { source: "assignment", channel: "assignment", routineName: null, at: started },
          ],
          sent: true,
          memoryChanges: null,
          skillChanges: null,
          knowledgeChanges: null,
          steps: [],
        },
      ],
    );

    await screen.findByRole("button", { name: /^Assignment from/ });
    expect(container.querySelector("[data-run]")).toBeNull();
  });
});

describe("the Tasks view's Assignments", () => {
  it("lists one in progress, counting it, as no Turn or Trigger shows it", async () => {
    mount([], [draft()]);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks 1/ }));

    const panel = await screen.findByRole("tabpanel", { name: "In progress" });
    const list = within(panel).getByRole("list", { name: "Assignments" });
    expect(within(list).getByRole("button", { name: /^Assignment from/ })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Cancel Draft the post" })).toBeTruthy();
  });

  it("lists an ended one under Done, with no Cancel", async () => {
    mount([], [draft({ status: "done", endedAt: createdAt, result: { outcome: "Drafted." } })]);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks 0/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Done" }));

    const panel = await screen.findByRole("tabpanel", { name: "Done" });
    expect(within(panel).getByRole("button", { name: /^Assignment from/ })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /^Cancel/ })).toBeNull();
  });
});

describe("following and cancelling an Assignment", () => {
  const at = new Date("2026-10-19T09:30:00.000Z");

  it("opens to its log: each status change, who made it, the Bot's notes, and a link to its Turn", async () => {
    const turn = document.createElement("div");
    turn.id = "turn-t1";
    turn.scrollIntoView = vi.fn();
    document.body.append(turn);
    mount(
      [said("m1", "user", "Hello")],
      [
        draft({
          log: [
            {
              id: "l1",
              status: "open",
              actor: "bot",
              actorName: "Scout",
              note: null,
              turnId: null,
              calls: null,
              costMicros: null,
              at: createdAt,
            },
            {
              id: "l2",
              status: "working",
              actor: "system",
              actorName: null,
              note: null,
              turnId: "t1",
              calls: null,
              costMicros: null,
              at,
            },
            {
              id: "l3",
              status: "working",
              actor: "bot",
              actorName: "Ada",
              note: "Halfway there.",
              turnId: "t1",
              calls: null,
              costMicros: null,
              at,
            },
            {
              id: "l4",
              status: "cancelled",
              actor: "user",
              actorName: null,
              note: null,
              turnId: null,
              calls: null,
              costMicros: null,
              at,
            },
          ],
        }),
      ],
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Assignment from/ }));

    const log = screen.getByRole("list", { name: "Log" });
    const entries = within(log)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toContain("by Scout");
    expect(entries[1]).toContain("by the SDK");
    expect(entries[2]).toContain("by Ada");
    expect(entries[2]).toContain("Halfway there.");
    expect(entries[3]).toContain("Cancelled");
    expect(entries[3]).toContain("by you");
    fireEvent.click(within(log).getAllByRole("button", { name: "Turn" })[0]!);
    expect(turn.scrollIntoView).toHaveBeenCalled();
    turn.remove();
  });

  it("shows no link to a Turn whose line isn't on the page", async () => {
    mount(
      [],
      [
        draft({
          log: [
            {
              id: "l1",
              status: "working",
              actor: "system",
              actorName: null,
              note: "Gone from the page.",
              turnId: "not-on-the-page",
              calls: null,
              costMicros: null,
              at,
            },
          ],
        }),
      ],
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Assignment from/ }));
    await screen.findByText("Gone from the page.");
    expect(screen.queryByRole("button", { name: "Turn" })).toBeNull();
  });

  it("shows the Assignment it was split off from, and those split off from it with their status", async () => {
    mount(
      [],
      [
        draft({
          status: "blocked",
          parent: { id: "p1", title: "Plan the launch", botName: "Scout" },
          children: [{ id: "c1", title: "Check the facts", botName: "Editor", status: "working" }],
        }),
      ],
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Assignment from Scout: Draft the post/ }),
    );

    expect(await screen.findByText("Part of Scout's Assignment: Plan the launch")).toBeTruthy();
    const children = within(screen.getByRole("list", { name: "Split off" }));
    expect(children.getByText("Check the facts, Editor")).toBeTruthy();
    expect(children.getByText("Working")).toBeTruthy();
  });

  it("shows the budget and each Turn's spend in the log", async () => {
    mount(
      [],
      [
        draft({
          log: [
            {
              id: "l1",
              status: "working",
              actor: "system",
              actorName: null,
              note: null,
              turnId: "t1",
              calls: 3,
              costMicros: 120_000,
              at: createdAt,
            },
          ],
        }),
      ],
    );
    fireEvent.click(await screen.findByRole("button", { name: /^(?!Cancel).*Draft the post/ }));
    const item = within(document.querySelector("[data-assignment='a1']") as HTMLElement);
    expect(item.getByText("3 of 30 model calls, $0.12 of $1.00")).toBeDefined();
    expect(item.getByText("3 model calls, $0.12")).toBeDefined();
  });

  it("offers a raise only when it's over budget, adding a default budget to the limits", async () => {
    const over = { ...draft().budget, calls: 30, overBudget: true };
    const raised: unknown[] = [];
    mount([], [draft({ status: "blocked", budget: over })], [], [], raised);
    fireEvent.click(
      await screen.findByRole("button", { name: "Raise the limit of Draft the post" }),
    );
    await vi.waitFor(() =>
      expect(raised).toEqual([
        { botId: ada.id, assignmentId: "a1", callLimit: 60, moneyLimitUsd: 2 },
      ]),
    );
  });

  it("offers no raise for one with budget left, or one blocked on a child", async () => {
    mount([], [draft({ status: "blocked" })]);
    await screen.findByRole("button", { name: "Cancel Draft the post" });
    expect(screen.queryByRole("button", { name: /Raise the limit/ })).toBeNull();
  });

  it("cancels from its collapsed item", async () => {
    const cancelled: string[] = [];
    mount([], [draft()], [], cancelled);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel Draft the post" }));

    await vi.waitFor(() => expect(cancelled).toEqual(["a1"]));
  });
});
