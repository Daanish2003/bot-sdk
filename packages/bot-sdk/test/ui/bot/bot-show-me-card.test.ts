// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  DemonstrationCard,
  DemonstrationState,
} from "../../../plugins/bot/shared/demonstration";
import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-21T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };
const goal = "Copy this week's payouts into the sheet";

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

const showMe = (state: DemonstrationState, steps = 0): BotMessage => {
  const demonstration: DemonstrationCard = {
    type: "demonstration",
    demonstrationId: "d1",
    goal,
    state,
    startedAt: createdAt.toISOString(),
    endedAt: state === "recording" || state === "paused" ? null : createdAt.toISOString(),
    steps,
  };
  return { ...said("m3", "assistant", goal), demonstration };
};

const linkOf = (n: number) => `/api/screens/token-${n}/vnc.html?autoconnect=1`;

/**
 * A stand-in for the server's `bot` router: the Conversation `messages()` gives, and the
 * Demonstration routes, which record their calls and run `onAct`; `view` gives a fresh link on each
 * call.
 */
function mount(messages: () => BotMessage[], onAct: (action: string) => void = () => {}) {
  const actCalls: unknown[] = [];
  const viewCalls: unknown[] = [];
  const action = (name: string) =>
    os.input(z.object({ demonstrationId: z.string() })).handler(({ input }) => {
      actCalls.push({ action: name, ...input });
      onAct(name);
      return { state: "recording" as const };
    });
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
      helper: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
      demonstration: {
        pause: action("pause"),
        resume: action("resume"),
        done: action("done"),
        cancel: action("cancel"),
        view: os.input(z.object({ demonstrationId: z.string() })).handler(({ input }) => {
          viewCalls.push(input);
          return { url: linkOf(viewCalls.length) };
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
  return { ...view, actCalls, viewCalls };
}

const showMeCard = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-show-me]");

const base = [
  said("m1", "user", "Let me show you how I copy the payouts"),
  said("m2", "assistant", "Go ahead."),
];

describe("the Show me card", () => {
  it("records: the goal, the dot and timer, a live view, the privacy line, Pause, Cancel and Done", async () => {
    const { container, viewCalls } = mount(() => [...base, showMe("recording")]);

    await waitFor(() => expect(showMeCard(container)).not.toBeNull());
    const card = showMeCard(container)!;
    expect(card.dataset.state).toBe("recording");
    // The card stands in for its Message's bubble.
    expect(container.querySelector('[data-bot-message][data-id="m3"]')).toBeNull();
    expect(card.textContent).toContain(`Show me: ${goal}`);
    expect(within(card).getByRole("img", { name: "Recording" })).toBeTruthy();
    expect(card.querySelector("[data-timer]")?.textContent).toMatch(/^\d+:\d\d$/);
    expect(card.textContent).toContain("Ada sees what you do. Pause before typing a password.");
    await waitFor(() =>
      expect(card.querySelector("[data-preview] iframe")?.getAttribute("src")).toBe(linkOf(1)),
    );
    expect(viewCalls).toEqual([{ demonstrationId: "d1" }]);
    for (const name of ["Pause", "Cancel", "Done", "Full screen"]) {
      expect(within(card).getByRole("button", { name })).toBeTruthy();
    }
    expect(within(card).queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("is paused: an amber dot, the paused line and Resume, which resumes it", async () => {
    let state: DemonstrationState = "paused";
    const { container, actCalls } = mount(
      () => [...base, showMe(state)],
      () => (state = "recording"),
    );
    await waitFor(() => expect(showMeCard(container)?.dataset.state).toBe("paused"));
    const card = showMeCard(container)!;
    expect(within(card).getByRole("img", { name: "Paused" })).toBeTruthy();
    expect(card.textContent).toContain(
      "Paused: nothing is recorded. Resume when you're past the sign-in.",
    );
    expect(within(card).queryByRole("button", { name: "Pause" })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(showMeCard(container)?.dataset.state).toBe("recording"));
    expect(actCalls).toEqual([{ action: "resume", demonstrationId: "d1" }]);
  });

  it("calls pause, cancel and done on its buttons", async () => {
    const { container, actCalls } = mount(() => [...base, showMe("recording")]);
    await waitFor(() => expect(showMeCard(container)).not.toBeNull());

    for (const name of ["Pause", "Cancel", "Done"]) {
      fireEvent.click(within(showMeCard(container)!).getByRole("button", { name }));
      await waitFor(() =>
        expect(actCalls).toHaveLength(["Pause", "Cancel", "Done"].indexOf(name) + 1),
      );
    }

    expect(actCalls).toEqual([
      { action: "pause", demonstrationId: "d1" },
      { action: "cancel", demonstrationId: "d1" },
      { action: "done", demonstrationId: "d1" },
    ]);
  });

  it("opens full screen under the red bar, which follows recording and paused, and shrinks back", async () => {
    let state: DemonstrationState = "recording";
    const { container } = mount(
      () => [...base, showMe(state)],
      (action) => (state = action === "pause" ? "paused" : "recording"),
    );
    await waitFor(() => expect(showMeCard(container)).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    const dialog = await screen.findByRole("dialog");
    const bar = () => dialog.querySelector("[data-red-bar]")?.textContent;
    expect(bar()).toContain("Recording. Ada sees what you do on this Screen.");
    await waitFor(() =>
      expect(dialog.querySelector("iframe")?.getAttribute("src")).toBe(linkOf(2)),
    );
    // One session at a time: the preview's view is closed under full screen.
    expect(showMeCard(container)?.querySelector("[data-preview] iframe")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(bar()).toContain("Paused. Sign in or type secrets now; the Bot sees nothing."),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Shrink" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the closed Show me divider", () => {
  it.each([
    ["drafting", 0, "Show me · 0 steps · Writing the Skill…"],
    ["saved", 1, "Show me · 1 step · Saved as a Skill"],
    ["cancelled", 3, "Show me · 3 steps · Cancelled"],
    ["failed", 2, "Show me · 2 steps · Couldn't write the Skill"],
  ] as const)("reads %s as one line", async (state, steps, line) => {
    const { container } = mount(() => [...base, showMe(state, steps)]);

    await waitFor(() => expect(showMeCard(container)?.dataset.state).toBe(state));
    expect(showMeCard(container)!.textContent).toBe(line);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(showMeCard(container)!.querySelector("iframe")).toBeNull();
  });
});
