// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { changeLog, stubEventSource } from "./fake-change-log";
import { tasksOf } from "./fake-tasks";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-29T09:00:00.000Z");
const resetAt = new Date("2026-10-29T10:00:00.000Z");

type Shown = { id: string; role: "user" | "assistant" | "reset"; text: string; createdAt: Date };

/** A stand-in for the server's `bot` router, with Ada's thread holding `messages`. */
function mount({ messages = [] as Shown[] } = {}) {
  const log = changeLog();
  const state = { resets: [] as string[], messages };
  const botInput = z.object({ botId: z.string() });
  const router = {
    conversations: {
      changes: os
        .input(z.object({ conversationId: z.string(), since: z.number() }))
        .handler(({ input }) => log.since(input.since)),
    },
    bots: {
      get: os.handler(() => ({
        bot: {
          id: "b2",
          name: "Ada",
          model: "openai:gpt-6-luna",
          createdAt,
          pausedAt: null,
          turnStatus: null,
        },
        conversationId: "c1",
        messages: state.messages,
        turns: [],
        lastSeq: log.last,
      })),
      tasks: os.handler(() => tasksOf()),
      reset: os.input(z.object({ botId: z.string(), name: z.string() })).handler(({ input }) => {
        state.resets.push(input.name);
        state.messages = [
          ...state.messages,
          { id: "m-reset", role: "reset", text: "", createdAt: resetAt },
        ];
      }),
    },
    routines: { list: os.input(botInput).handler(() => []) },
    checkIns: { list: os.input(botInput).handler(() => []) },
    helpers: { list: os.input(botInput).handler(() => []) },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  render(providerFor(createElement(BotConversation, { botId: "b2" }), { fetch, messages: {} }));
  return state;
}

const openResetDialog = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Bot menu" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reset Bot…" }));
  return screen.findByRole("dialog");
};

describe("Bot reset", () => {
  it("opens from the ⋯ menu with what is wiped and what is kept", async () => {
    mount();

    const dialog = await openResetDialog();

    expect(within(dialog).getByText("Reset Ada?")).toBeTruthy();
    const wiped = within(within(dialog).getByRole("region", { name: "Wiped" })).getAllByRole(
      "listitem",
    );
    expect(wiped.map((item) => item.textContent)).toEqual([
      "its own Memory: Profile, Log and Notes",
      "its Routines and Check-ins",
      "its Helpers and their transcripts",
      "pending Approvals, and anything waiting to run",
      "what it remembers of this conversation (you still see it)",
    ]);
    const kept = within(within(dialog).getByRole("region", { name: "Kept" })).getAllByRole(
      "listitem",
    );
    expect(kept.map((item) => item.textContent)).toEqual([
      "Skills, and its other files",
      "Knowledge, Custom Rules and Screen sign-ins",
      "its name, model and settings, and Channel links",
      "usage and Quota records",
    ]);
  });

  it("resets only once the Bot's name is typed exactly, then closes", async () => {
    const state = mount();
    const dialog = await openResetDialog();
    const reset = within(dialog).getByRole("button", { name: "Reset" });
    const name = within(dialog).getByRole("textbox", { name: "Type Ada to confirm" });

    expect(reset.hasAttribute("disabled")).toBe(true);
    for (const typed of ["ada", "Ad", "Ada "]) {
      fireEvent.change(name, { target: { value: typed } });
      expect(reset.hasAttribute("disabled")).toBe(true);
    }
    fireEvent.change(name, { target: { value: "Ada" } });
    expect(reset.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reset);

    await waitFor(() => expect(state.resets).toEqual(["Ada"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The thread is read again, and its reset mark shows as a divider.
    expect(
      await screen.findByRole("separator", {
        name: "Reset: the Bot sees nothing above this line",
      }),
    ).toBeTruthy();
  });

  it("shows the reset mark as a divider between the old and new Messages, not as a bubble", async () => {
    mount({
      messages: [
        { id: "m1", role: "user", text: "The code is 4417", createdAt },
        { id: "m2", role: "reset", text: "", createdAt: resetAt },
        { id: "m3", role: "user", text: "Hello again", createdAt: new Date(resetAt.getTime() + 1) },
      ],
    });

    const divider = await screen.findByRole("separator", {
      name: "Reset: the Bot sees nothing above this line",
    });
    expect(screen.getByText("The code is 4417")).toBeTruthy();
    expect(screen.getByText("Hello again")).toBeTruthy();
    const bubbles = [...document.querySelectorAll("[data-bot-message]")].map((node) =>
      node.getAttribute("data-id"),
    );
    expect(bubbles).toEqual(["m1", "m3"]);
    // The divider sits between the two Messages.
    const order = [...document.querySelectorAll("[data-bot-message], [data-reset-mark]")];
    expect(order.indexOf(divider)).toBe(1);
  });
});
