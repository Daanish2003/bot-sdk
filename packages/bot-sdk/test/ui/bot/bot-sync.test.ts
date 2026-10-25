// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { safetyFetchMs } from "../../../plugins/bot/client/react/bot-sync";
import type { BotChanges } from "../../../plugins/bot/shared/changes";
import type { BotMessage, BotTurnStatus } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";
import { changeLog, FakeEventSource, hint, settle, stubEventSource } from "./fake-change-log";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-22T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

let tick = 0;
const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt: new Date(createdAt.getTime() + ++tick * 1000),
});

/**
 * A stand-in for the server's `bot` router that keeps a change log: `bot.get` answers with
 * `messages` and the log's newest seq, `bot.changes` with the log (or what `answer` overrides it
 * with), and `gets` counts the reads of the whole thread.
 */
function fakeBotServer(messages: BotMessage[], turnStatus: BotTurnStatus | null = null) {
  const log = changeLog();
  const state = { messages, turnStatus, gets: 0, answer: undefined as BotChanges | undefined };
  const router = {
    bot: {
      get: os.handler(() => {
        state.gets++;
        return {
          bot: { ...ada, turnStatus: state.turnStatus, userTurnStatus: state.turnStatus },
          conversationId: "c1",
          messages: [...state.messages],
          lastSeq: log.last,
        };
      }),
      changes: os
        .input(z.object({ botId: z.string(), since: z.number() }))
        .handler(({ input }) => state.answer ?? log.since(input.since)),
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  /** The Bot sends `message`: saved and logged, but no hint goes out. */
  const send = (message: BotMessage) => {
    state.messages.push(message);
    log.record("message", message.id, message);
  };
  return { fetch, log, state, send };
}

function mount(server: ReturnType<typeof fakeBotServer>) {
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), {
      fetch: server.fetch,
      messages: {},
    }),
  );
}

const bubbles = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-bot-message]")].map(
    (bubble) => bubble.textContent,
  );

describe("the change log applied to the thread", () => {
  it("applies the changes in seq order, so a later change to a Message wins", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    const { container } = mount(server);
    await screen.findByText("hi");

    server.send(said("m1", "assistant", "one"));
    server.send(said("m2", "assistant", "two"));
    // Message m1 was edited after m2 arrived.
    server.log.record("message", "m1", { ...server.state.messages[1]!, text: "one, edited" });
    await hint();

    await waitFor(() => expect(bubbles(container)).toEqual(["hi", "one, edited", "two"]));
    // Each Message sits once, in the order it was saved.
    expect(server.state.gets).toBe(1);
  });

  it("fetches only the changes after the cursor, which moves on with each fetch", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    mount(server);
    await screen.findByText("hi");

    server.send(said("m1", "assistant", "one"));
    await hint();
    server.send(said("m2", "assistant", "two"));
    await hint();

    await screen.findByText("two");
    // The first fetch is the reconnect's, at the thread's seq; then one per hint.
    expect(server.log.calls.slice(-2)).toEqual([0, 1]);
  });

  it("reads the thread afresh when the log no longer holds the cursor", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    const { container } = mount(server);
    await screen.findByText("hi");

    server.send(said("m1", "assistant", "one"));
    server.send(said("m2", "assistant", "two"));
    server.send(said("m3", "assistant", "three"));
    // The log kept only the newest: the cursor 0 is older than it.
    server.log.trim(2);
    await hint();

    await waitFor(() => expect(bubbles(container)).toEqual(["hi", "one", "two", "three"]));
    expect(server.state.gets).toBe(2);
  });

  it("reads the thread afresh when the changes skip a number", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    const { container } = mount(server);
    await screen.findByText("hi");

    server.state.messages.push(said("m1", "assistant", "one"));
    // The server's answer starts at seq 2, not 1.
    server.state.answer = {
      reload: false,
      changes: [{ seq: 2, kind: "message", refId: "m1", at: createdAt, data: null }],
    };
    await hint();

    await waitFor(() => expect(bubbles(container)).toEqual(["hi", "one"]));
    expect(server.state.gets).toBe(2);
  });

  it("reads the thread afresh when the server says reload", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    const { container } = mount(server);
    await screen.findByText("hi");

    server.state.messages.push(said("m1", "assistant", "one"));
    server.state.answer = { reload: true };
    await hint();

    await waitFor(() => expect(bubbles(container)).toEqual(["hi", "one"]));
    expect(server.state.gets).toBe(2);
  });
});

describe("catching up on a missed signal", () => {
  it("fetches when the window gets focus", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    mount(server);
    await screen.findByText("hi");

    server.send(said("m1", "assistant", "missed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await screen.findByText("missed");
  });

  it("fetches when the events stream reconnects", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    mount(server);
    await screen.findByText("hi");

    server.send(said("m1", "assistant", "missed"));
    await act(async () => {
      FakeEventSource.reconnect();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await screen.findByText("missed");
  });

  it("listens to the Conversation's events stream, and closes it when the page goes", async () => {
    const server = fakeBotServer([said("m0", "user", "hi")]);
    const { unmount } = mount(server);
    await screen.findByText("hi");

    expect(FakeEventSource.open.map((source) => source.url)).toContain(
      "http://localhost/api/chat/events?conversationId=c1",
    );
    unmount();
    expect(FakeEventSource.open).toEqual([]);
  });
});

describe("with no signal", () => {
  it("doesn't ask for anything while idle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeBotServer([said("m0", "user", "hi")]);
    mount(server);
    await screen.findByText("hi");
    await settle();
    const asked = server.log.calls.length;
    const reads = server.state.gets;

    await act(() => vi.advanceTimersByTimeAsync(5 * safetyFetchMs));

    expect(server.log.calls.length).toBe(asked);
    expect(server.state.gets).toBe(reads);
  });

  it("clears Working… within the safety fetch, even if the last hint is lost", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeBotServer([said("m0", "user", "hi")], "running");
    mount(server);
    expect(await screen.findByRole("status", { name: "Typing" })).toBeTruthy();
    // The stream has opened, and its first fetch is done.
    await settle();

    // The Turn ends, and its hint is lost.
    server.state.turnStatus = "complete";
    server.log.record("turn", "t1", {
      id: "t1",
      status: "complete",
      startedAt: createdAt,
      endedAt: createdAt,
    });
    await act(() => vi.advanceTimersByTimeAsync(safetyFetchMs));

    await waitFor(() => expect(screen.queryByRole("status", { name: "Typing" })).toBeNull());
  });
});
