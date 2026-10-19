// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotHelper, ComputerCard } from "../../../plugins/bot/shared/helper";
import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
});

const createdAt = new Date("2026-10-19T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };
const reason = "Sign in to Salesforce: enter your password and the code from your phone.";

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

const handOff = (state: ComputerCard["state"]): BotMessage => ({
  ...said("m3", "assistant", reason),
  computer: { type: "computer", helperId: "h1", reason, state },
});

const helper: BotHelper = {
  id: "h1",
  type: "computer_use",
  task: "Read the deals on the Salesforce dashboard.\nReport them.",
  gist: "Read the deals on the Salesforce dashboard.",
  status: "waiting",
  steps: 3,
  latest: "ask_user",
  report: null,
  startedAt: createdAt,
  afterMessageId: "m2",
};

/**
 * A stand-in for the server's `bot` router: the Conversation `messages()` gives, one Helper, and a
 * `helper.done` that records its calls and runs `onDone`.
 */
function mount(messages: () => BotMessage[], onDone: () => void = () => {}) {
  const doneCalls: unknown[] = [];
  const router = {
    bot: {
      get: os.handler(() => ({
        bot: { ...ada, turnStatus: null },
        messages: messages(),
        turns: [],
      })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(async function* () {}),
      routine: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
      checkIn: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
      helper: {
        list: os.input(z.object({ botId: z.string() })).handler(() => [helper]),
        stop: os.input(z.object({ botId: z.string() }).loose()).handler(() => {}),
        done: os.input(z.object({ helperId: z.string() })).handler(({ input }) => {
          doneCalls.push(input);
          onDone();
          return { status: "running" as const };
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  const view = render(
    providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }),
  );
  return { ...view, doneCalls };
}

const computerCard = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-computer-card]");

const base = [
  said("m1", "user", "What deals are on my dashboard?"),
  said("m2", "assistant", "On it."),
];

describe("the Computer card", () => {
  it("follows the hand-off Message with its reason, a preview, Done, Copy link and View details", async () => {
    const { container } = mount(() => [...base, handOff("open")]);

    await waitFor(() => expect(computerCard(container)).not.toBeNull());
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-computer-card]"),
    ].map((row) => (row.dataset.computerCard === undefined ? row.dataset.id : "card"));
    expect(rows).toEqual(["m1", "m2", "m3", "card"]);
    const card = computerCard(container)!;
    expect(card.dataset.state).toBe("open");
    expect(card.textContent).toContain(reason);
    expect(card.querySelector("[data-preview]")).not.toBeNull();
    for (const name of ["Done", "Copy link", "View details"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(card.textContent).not.toContain("Report them.");

    fireEvent.click(screen.getByRole("button", { name: "View details" }));

    expect(card.textContent).toContain("Read the deals on the Salesforce dashboard.");
    expect(card.textContent).toContain("Report them.");
  });

  it("calls bot.helper.done on Done, then collapses to done", async () => {
    let state: ComputerCard["state"] = "open";
    const { container, doneCalls } = mount(
      () => [...base, handOff(state)],
      () => (state = "done"),
    );
    await screen.findByRole("button", { name: "Done" });

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(computerCard(container)?.dataset.state).toBe("done"));
    expect(doneCalls).toEqual([{ helperId: "h1" }]);
    expect(computerCard(container)!.textContent).toBe(
      "Read the deals on the Salesforce dashboard.: done",
    );
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("reads cancelled once the task was stopped", async () => {
    const { container } = mount(() => [...base, handOff("cancelled")]);

    await waitFor(() => expect(computerCard(container)?.dataset.state).toBe("cancelled"));
    expect(computerCard(container)!.textContent).toBe(
      "Read the deals on the Salesforce dashboard.: cancelled",
    );
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });
});
