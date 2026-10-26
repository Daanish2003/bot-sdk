// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotCheckIn } from "../../../plugins/bot/shared/check-in";
import type { BotMessage, BotTurnProvenance } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

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

const acme = (afterMessageId: string): BotCheckIn => ({
  id: "c1",
  at: new Date("2026-10-22T08:00:00.000Z"),
  note: "Has Acme replied?",
  state: "pending",
  createdAt,
  afterMessageId,
});

/** A stand-in for the server's `bot` router, with the Check-ins a test gives it. */
function fakeBotServer(
  messages: BotMessage[],
  checkIns: BotCheckIn[],
  turns: BotTurnProvenance[] = [],
) {
  const cancelled: string[] = [];
  const router = {
    bots: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .handler(({ input }) => ({
          id: input.id,
          role: "user" as const,
          text: input.text,
          createdAt: new Date(),
        })),
    },
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    checkIns: {
      list: os.input(z.object({ botId: z.string() })).handler(() => [...checkIns]),
      cancel: os.input(z.object({ checkInId: z.string() })).handler(({ input }) => {
        cancelled.push(input.checkInId);
        checkIns.find((row) => row.id === input.checkInId)!.state = "cancelled";
      }),
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, cancelled };
}

function mount(server: ReturnType<typeof fakeBotServer>) {
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), {
      fetch: server.fetch,
      messages: {},
    }),
  );
}

describe("a Check-in the Bot set", () => {
  it("shows an inline line right after the Turn that set it, with its time and note", async () => {
    const server = fakeBotServer(
      [
        said("m1", "user", "Tell me Thursday if Acme replied"),
        said("m2", "assistant", "Will do."),
        said("m3", "user", "Thanks"),
      ],
      [acme("m2")],
    );
    const { container } = mount(server);

    await screen.findByText(/Check-in set for/);
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-check-in]"),
    ].map((row) => (row.dataset.checkIn ? `check-in:${row.dataset.state}` : row.textContent));
    expect(rows).toEqual([
      "Tell me Thursday if Acme replied",
      "Will do.",
      "check-in:pending",
      "Thanks",
    ]);
    expect(container.querySelector("[data-check-in]")!.textContent).toMatch(
      /^Check-in set for \S.*: "Has Acme replied\?".*Cancel$/,
    );
  });

  it("cancels through the router, and the line is struck through with no Cancel", async () => {
    const server = fakeBotServer([said("m1", "user", "Tell me Thursday")], [acme("m1")]);
    const { container } = mount(server);
    const line = () => container.querySelector<HTMLElement>("[data-check-in]")!;
    await screen.findByText(/Check-in set for/);

    fireEvent.click(within(line()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(line().dataset.state).toBe("cancelled"));
    expect(server.cancelled).toEqual(["c1"]);
    expect(within(line()).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(line().querySelector(".line-through")?.textContent).toMatch(/Has Acme replied/);
  });

  it("shows a Check-in whose fire failed as failed, with no Cancel", async () => {
    const server = fakeBotServer(
      [said("m1", "user", "Tell me Thursday")],
      [{ ...acme("m1"), state: "failed" }],
    );
    const { container } = mount(server);

    await screen.findByText(/Check-in set for/);

    const line = container.querySelector<HTMLElement>("[data-check-in]")!;
    expect(line.dataset.state).toBe("failed");
    expect(line.textContent).toMatch(/Has Acme replied?.*failed/i);
    expect(within(line).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("lists the pending Check-ins in the header popover, with Cancel", async () => {
    const server = fakeBotServer(
      [said("m1", "user", "Tell me Thursday")],
      [acme("m1"), { ...acme("m1"), id: "c2", note: "Done already", state: "cancelled" }],
    );
    mount(server);

    fireEvent.click(await screen.findByRole("button", { name: /^Routines 0 · Check-ins 1/ }));
    const list = await screen.findByRole("list", { name: "Check-ins" });

    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/Has Acme replied\?.*Cancel$/),
    ]);
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(server.cancelled).toEqual(["c1"]));
  });

  it("gives a fired Check-in's Turn its run divider", async () => {
    const fired: BotTurnProvenance = {
      id: "t2",
      status: "complete",
      startedAt: new Date("2026-10-22T08:00:01.000Z"),
      endedAt: new Date("2026-10-22T08:00:05.000Z"),
      sent: true,
      memoryChanges: null,
      skillChanges: null,
      knowledgeChanges: null,
      steps: [],
      triggers: [
        {
          source: "check_in",
          channel: "schedule",
          routineName: null,
          at: new Date("2026-10-22T08:00:00.000Z"),
        },
      ],
    };
    const server = fakeBotServer(
      [
        said("m1", "user", "Tell me Thursday"),
        {
          ...said("m2", "assistant", "Acme has not replied."),
          createdAt: new Date("2026-10-22T08:00:03.000Z"),
        },
      ],
      [],
      [fired],
    );
    const { container } = mount(server);

    await screen.findByText("Acme has not replied.");
    expect(container.querySelector("[data-run]")?.textContent).toMatch(/^Check-in · \S.*$/);
  });
});
