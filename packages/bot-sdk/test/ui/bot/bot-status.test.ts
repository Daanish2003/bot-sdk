// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, Fragment, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotMessage, BotSendEvent, BotTurnStatus } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { BotSidebar } from "../../../plugins/bot/ui/bot-sidebar";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-17T09:00:00.000Z");
const bots = [
  { id: "b1", name: "Inbox Manager", model: "openai:gpt-5.6", createdAt },
  { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt },
];

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

type ServerBot = {
  messages?: BotMessage[];
  turnStatus?: BotTurnStatus | null;
  lastMessage?: { text: string; at: Date } | null;
};

/**
 * A stand-in for the server's `bot` router. `bot.list` and `bot.get` answer from `state`, and each
 * `bot.send` streams the events the test pushes until it ends the stream.
 */
function fakeBotServer(state: Record<string, ServerBot> = {}) {
  const queue: (BotSendEvent | "end")[] = [];
  let wake = () => {};
  const push = (event: BotSendEvent | "end") => {
    queue.push(event);
    wake();
  };
  const router = {
    bot: {
      list: os.handler(() =>
        bots.map((bot) => ({
          ...bot,
          turnStatus: state[bot.id]?.turnStatus ?? null,
          lastMessage: state[bot.id]?.lastMessage ?? null,
        })),
      ),
      get: os.input(z.object({ botId: z.string() })).handler(({ input }) => ({
        bot: {
          ...bots.find((bot) => bot.id === input.botId)!,
          turnStatus: state[input.botId]?.turnStatus ?? null,
        },
        messages: state[input.botId]?.messages ?? [],
      })),
      send: os
        .input(z.object({ botId: z.string(), text: z.string() }))
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(async function* () {
          while (true) {
            if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            const next = queue.shift()!;
            if (next === "end") return;
            yield next;
          }
        }),
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return {
    fetch,
    /** Streams `events` of a send to Ada, which the server saves as they go. */
    stream: async (...events: (BotSendEvent | "end")[]) => {
      for (const event of events) {
        if (event === "end") continue;
        const ada = (state.b2 ??= {});
        if (event.type === "message") {
          ada.messages = [...(ada.messages ?? []), event.message];
          ada.turnStatus = "running";
        } else ada.turnStatus = event.status;
      }
      await act(async () => {
        for (const event of events) push(event);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
  };
}

/** The sidebar beside a Conversation that a button switches between the two Bots. */
function Harness() {
  const [botId, setBotId] = useState("b2");
  return createElement(
    Fragment,
    null,
    createElement(BotSidebar),
    createElement("button", { onClick: () => setBotId("b1") }, "open Inbox"),
    createElement("button", { onClick: () => setBotId("b2") }, "open Ada"),
    createElement(BotConversation, { botId }),
  );
}

async function mount(server: ReturnType<typeof fakeBotServer>) {
  const view = render(providerFor(createElement(Harness), { fetch: server.fetch, messages: {} }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return view;
}

async function type(text: string) {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

const bubbles = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-bot-message]")].map((bubble) => [
    bubble.dataset.role,
    bubble.textContent,
  ]);

describe("a Turn that outlives the Conversation view", () => {
  it("keeps running, and its sidebar row keeps saying Working…, when the user opens another Bot and comes back", async () => {
    const server = fakeBotServer();
    const { container } = await mount(server);
    await type("hi");
    await server.stream({ type: "message", message: said("m1", "user", "hi") });
    expect(screen.getAllByText("Working…")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "open Inbox" }));
    await server.stream({ type: "message", message: said("m2", "assistant", "On it…") });
    expect(screen.getAllByText("Working…")).toHaveLength(1);
    expect(bubbles(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "open Ada" }));
    await server.stream({ type: "message", message: said("m3", "assistant", "Done.") });

    expect(bubbles(container)).toEqual([
      ["user", "hi"],
      ["assistant", "On it…"],
      ["assistant", "Done."],
    ]);
    expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

    await server.stream({ type: "turnEnded", status: "complete" }, "end");
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
  });
});

describe("statuses from server state, with no send in flight", () => {
  it("shows ••• and Working… for a running Turn", async () => {
    await mount(
      fakeBotServer({
        b2: { messages: [said("m1", "user", "hi")], turnStatus: "running" },
      }),
    );

    expect(await screen.findByRole("status", { name: "Typing" })).toBeTruthy();
    expect(screen.getAllByText("Working…")).toHaveLength(1);
  });

  it("shows Seen ✓ under the last user Message after a complete Turn", async () => {
    await mount(
      fakeBotServer({ b2: { messages: [said("m1", "user", "ok")], turnStatus: "complete" } }),
    );

    expect(await screen.findAllByText("Seen ✓")).toHaveLength(1);
    expect(screen.queryByText("Couldn't reply")).toBeNull();
  });

  it("shows no Seen ✓ when the last Message is the Bot's", async () => {
    await mount(
      fakeBotServer({
        b2: {
          messages: [said("m1", "user", "hi"), said("m2", "assistant", "Hello!")],
          turnStatus: "complete",
        },
      }),
    );

    await screen.findByText("Hello!");
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });

  it("shows Couldn't reply under the last user Message after a failed Turn", async () => {
    await mount(
      fakeBotServer({ b2: { messages: [said("m1", "user", "hi")], turnStatus: "error" } }),
    );

    expect(await screen.findAllByText("Couldn't reply")).toHaveLength(1);
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});

describe("the sidebar rows", () => {
  it("shows the time and a preview of the last sent Message, and Working… instead while a Turn runs", async () => {
    const { container } = await mount(
      fakeBotServer({
        b1: { lastMessage: { text: "All caught up", at: new Date("2026-10-17T09:30:00Z") } },
        b2: {
          turnStatus: "running",
          lastMessage: { text: "Earlier reply", at: new Date("2026-10-17T09:10:00Z") },
        },
      }),
    );

    expect(await screen.findByText("All caught up")).toBeTruthy();
    const times = [...container.querySelectorAll("time")];
    expect(times.map((time) => time.getAttribute("datetime"))).toEqual([
      "2026-10-17T09:30:00.000Z",
      "2026-10-17T09:10:00.000Z",
    ]);
    expect(screen.getAllByText("Working…")).toHaveLength(1);
    expect(screen.queryByText("Earlier reply")).toBeNull();
  });
});
