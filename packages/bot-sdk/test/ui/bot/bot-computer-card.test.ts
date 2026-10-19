// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotHelper, ComputerCard } from "../../../plugins/bot/shared/helper";
import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

/** The live-view link the stand-in's `screen.view` gives on its `n`th call. */
const linkOf = (n: number) =>
  `/api/screens/token-${n}/vnc.html?autoconnect=1&path=api%2Fscreens%2Ftoken-${n}%2Fwebsockify`;

/**
 * A stand-in for the server's `bot` router: the Conversation `messages()` gives, one Helper, a
 * `helper.done` that records its calls and runs `onDone`, a `screen.view` that gives a fresh link
 * on each call, and a `screen.control` that records the modes it was asked for.
 */
function mount(messages: () => BotMessage[], onDone: () => void = () => {}) {
  const doneCalls: unknown[] = [];
  const viewCalls: unknown[] = [];
  const controlCalls: unknown[] = [];
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
      screen: {
        view: os.input(z.object({ helperId: z.string() })).handler(({ input }) => {
          viewCalls.push(input);
          return { url: linkOf(viewCalls.length) };
        }),
        control: os
          .input(z.object({ helperId: z.string(), mode: z.enum(["view", "control"]) }))
          .handler(({ input }) => {
            controlCalls.push(input);
          }),
      },
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
  return { ...view, doneCalls, viewCalls, controlCalls };
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

describe("the live view", () => {
  const takeover = () => screen.queryByRole("dialog");
  const note = "Type passwords and codes here yourself; the Bot never sees them";

  it("shows the Screen live in the card's preview", async () => {
    const { container, viewCalls } = mount(() => [...base, handOff("open")]);

    await waitFor(() =>
      expect(
        computerCard(container)?.querySelector("[data-preview] iframe")?.getAttribute("src"),
      ).toBe(linkOf(1)),
    );
    expect(viewCalls).toEqual([{ helperId: "h1" }]);
    // The sandbox serves the page, so it runs in an opaque origin.
    expect(
      computerCard(container)?.querySelector("[data-preview] iframe")?.getAttribute("sandbox"),
    ).toBe("allow-scripts");
  });

  it("opens the full-screen takeover from the preview, view-only, and closes it", async () => {
    const { container, controlCalls } = mount(() => [...base, handOff("open")]);
    await waitFor(() => expect(computerCard(container)?.querySelector("iframe")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Preview of the Screen" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(reason);
    expect(dialog.textContent).toContain(note);
    await waitFor(() =>
      expect(dialog.querySelector("iframe")?.getAttribute("src")).toBe(linkOf(2)),
    );
    expect(within(dialog).getByRole("button", { name: "Take control" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Done, hand it back" })).toBeTruthy();
    expect(controlCalls).toEqual([]);
    // One session at a time: the preview's view is closed under the takeover.
    expect(computerCard(container)?.querySelector("[data-preview] iframe")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(takeover()).toBeNull());
    expect(controlCalls).toEqual([]);
    // And comes back on a fresh link.
    await waitFor(() =>
      expect(
        computerCard(container)?.querySelector("[data-preview] iframe")?.getAttribute("src"),
      ).toBe(linkOf(3)),
    );
  });

  it("gives control back when the takeover closes in control", async () => {
    const { controlCalls } = mount(() => [...base, handOff("open")]);
    fireEvent.click(await screen.findByRole("button", { name: "Take control" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Give back control" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(controlCalls).toEqual([
        { helperId: "h1", mode: "control" },
        { helperId: "h1", mode: "view" },
      ]),
    );
    expect(takeover()).toBeNull();
  });

  it("opens the takeover in control from Take control, and gives it back", async () => {
    const { controlCalls } = mount(() => [...base, handOff("open")]);

    fireEvent.click(await screen.findByRole("button", { name: "Take control" }));

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Give back control" });
    expect(controlCalls).toEqual([{ helperId: "h1", mode: "control" }]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Give back control" }));

    await within(dialog).findByRole("button", { name: "Take control" });
    expect(controlCalls).toEqual([
      { helperId: "h1", mode: "control" },
      { helperId: "h1", mode: "view" },
    ]);
  });

  it("hands the Screen back with Done from the takeover", async () => {
    let state: ComputerCard["state"] = "open";
    const { container, doneCalls, controlCalls } = mount(
      () => [...base, handOff(state)],
      () => (state = "done"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Take control" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Give back control" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Done, hand it back" }));

    await waitFor(() => expect(computerCard(container)?.dataset.state).toBe("done"));
    expect(doneCalls).toEqual([{ helperId: "h1" }]);
    expect(controlCalls.at(-1)).toEqual({ helperId: "h1", mode: "view" });
    expect(takeover()).toBeNull();
  });

  it("copies a fresh link on Copy link", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { viewCalls } = mount(() => [...base, handOff("open")]);
    await waitFor(() => expect(viewCalls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${linkOf(2)}`),
    );
  });
});
