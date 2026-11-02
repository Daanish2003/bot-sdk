// @vitest-environment jsdom
import type { BotAssignment } from "@botsdk/client/bot/assignment";
import type { BotMessage, BotTurnProvenance } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
  overdueAt: null,
  createdAt,
  endedAt: null,
  afterMessageId: null,
  ...fields,
});

/** A stand-in for the server's routers, with the Assignments a test gives it. */
function mount(
  messages: BotMessage[],
  assignments: BotAssignment[],
  turns: BotTurnProvenance[] = [],
) {
  const router = {
    bots: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns })),
      tasks: os.handler(() => tasksOf({ assignments })),
    },
    assignments: {
      list: os.input(z.object({ botId: z.string() })).handler(() => assignments),
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

    const toggle = await screen.findByRole("button", { name: /Draft the post/ });
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

    const toggle = await screen.findByRole("button", { name: /Draft the post/ });
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

    await screen.findByRole("button", { name: /Draft the post/ });
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

    await screen.findByRole("button", { name: /Draft the post/ });
    expect(container.querySelector("[data-run]")).toBeNull();
  });
});

describe("the Tasks view's Assignments", () => {
  it("lists one in progress, read-only, leaving the count to the live work", async () => {
    mount([], [draft()]);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks 0/ }));

    const panel = await screen.findByRole("tabpanel", { name: "In progress" });
    const list = within(panel).getByRole("list", { name: "Assignments" });
    expect(within(list).getByRole("button", { name: /Draft the post/ })).toBeTruthy();
    expect(within(list).getAllByRole("button")).toHaveLength(1);
  });

  it("lists an ended one under Done", async () => {
    mount([], [draft({ status: "done", endedAt: createdAt, result: { outcome: "Drafted." } })]);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks 0/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Done" }));

    const panel = await screen.findByRole("tabpanel", { name: "Done" });
    expect(within(panel).getByRole("button", { name: /Draft the post/ })).toBeTruthy();
  });
});
