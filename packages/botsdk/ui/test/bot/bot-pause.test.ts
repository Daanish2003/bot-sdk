// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const pausedAt = new Date("2026-10-29T10:00:00.000Z");

/** A stand-in for the server's `bot` router, with Ada paused at `pausedAt` or not. */
function mount({ paused = false }: { paused?: boolean } = {}) {
  const log = changeLog();
  const state = { pausedAt: paused ? pausedAt : null, pauses: 0, resumes: 0 };
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
          pausedAt: state.pausedAt,
          turnStatus: null,
        },
        conversationId: "c1",
        messages: [],
        turns: [],
        lastSeq: log.last,
      })),
      tasks: os.handler(() => tasksOf()),
      pause: os.input(botInput).handler(() => {
        state.pauses += 1;
        state.pausedAt = pausedAt;
      }),
      resume: os.input(botInput).handler(() => {
        state.resumes += 1;
        state.pausedAt = null;
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

const openMenu = async () =>
  fireEvent.click(await screen.findByRole("button", { name: "Bot menu" }));

describe("Bot pause", () => {
  it("pauses from the ⋯ menu: the badge, the banner and a disabled composer show", async () => {
    const state = mount();
    expect((await screen.findByRole("textbox", { name: "Message" })).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.queryByText("Paused")).toBeNull();

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause Bot" }));

    await waitFor(() => expect(state.pauses).toBe(1));
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(await screen.findByText("Bot is paused. Resume to send.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message" }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("resumes from the banner: the badge and banner go, and the composer is enabled", async () => {
    const state = mount({ paused: true });
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(state.resumes).toBe(1));
    await waitFor(() => expect(screen.queryByText("Paused")).toBeNull());
    expect(screen.queryByText("Bot is paused. Resume to send.")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false);
  });

  it("offers Resume Bot in the ⋯ menu while paused", async () => {
    const state = mount({ paused: true });

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Pause Bot" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Resume Bot" }));

    await waitFor(() => expect(state.resumes).toBe(1));
    await waitFor(() => expect(screen.queryByText("Paused")).toBeNull());
  });
});
