// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-17T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

/**
 * A stand-in for the server's `bot` router: `bot.get` answers with `messages`, and each `bot.send`
 * streams the events the test pushes, until it ends the stream.
 */
function fakeBotServer(messages: BotMessage[] = []) {
  // Events pushed before the send's request arrives wait here for it.
  const queue: (BotSendEvent | "end")[] = [];
  let wake = () => {};
  const push = (event: BotSendEvent | "end") => {
    queue.push(event);
    wake();
  };
  const sends: unknown[] = [];
  const router = {
    bot: {
      get: os.handler(() => ({ bot: ada, messages })),
      send: os
        .input(z.object({ botId: z.string(), text: z.string() }))
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(async function* ({ input }) {
          sends.push(input);
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
    sends,
    /** Streams `events` to the open send, then lets the client read them. */
    stream: async (...events: (BotSendEvent | "end")[]) => {
      await act(async () => {
        for (const event of events) push(event);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
  };
}

function mount(server: ReturnType<typeof fakeBotServer>) {
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), {
      fetch: server.fetch,
      messages: {},
    }),
  );
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

describe("talking to a Bot", () => {
  it("shows the user's Message at once, and the saved one replaces it", async () => {
    const server = fakeBotServer();
    const { container } = mount(server);

    await type("hello");

    expect(bubbles(container)).toEqual([["user", "hello"]]);
    await waitFor(() => expect(server.sends).toEqual([{ botId: ada.id, text: "hello" }]));
    await server.stream({ type: "message", message: said("m1", "user", "hello") });
    expect(bubbles(container)).toEqual([["user", "hello"]]);
    expect(container.querySelector("[data-bot-message][data-id=m1]")).toBeTruthy();
  });

  it("shows only the sent Messages, the user's on the right and the Bot's on the left", async () => {
    const server = fakeBotServer([said("m0", "user", "earlier")]);
    const { container } = mount(server);
    await screen.findByText("earlier");

    await type("hi");
    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "message", message: said("m2", "assistant", "On it…") },
      { type: "message", message: said("m3", "assistant", "Done.") },
      { type: "turnEnded", status: "complete" },
      "end",
    );

    expect(bubbles(container)).toEqual([
      ["user", "earlier"],
      ["user", "hi"],
      ["assistant", "On it…"],
      ["assistant", "Done."],
    ]);
    const sides = [...container.querySelectorAll<HTMLElement>("[data-bot-message]")].map(
      (bubble) => (bubble.className.includes("self-end") ? "right" : "left"),
    );
    expect(sides).toEqual(["right", "right", "left", "left"]);
  });

  it("shows ••• while the Turn runs, and not once it has ended", async () => {
    const server = fakeBotServer();
    mount(server);
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();

    await type("hi");
    expect(screen.getByRole("status", { name: "Typing" }).textContent).toContain("•••");

    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "turnEnded", status: "complete" },
      "end",
    );
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
  });

  it("shows Seen ✓ under the last user Message only, after a quiet Turn", async () => {
    const server = fakeBotServer();
    const { container } = mount(server);

    await type("ok");
    await server.stream({ type: "message", message: said("m1", "user", "ok") });
    expect(screen.queryByText("Seen ✓")).toBeNull();
    await server.stream({ type: "turnEnded", status: "complete" }, "end");
    expect(screen.getAllByText("Seen ✓")).toHaveLength(1);

    await type("brb");
    await server.stream(
      { type: "message", message: said("m2", "user", "brb") },
      { type: "turnEnded", status: "complete" },
      "end",
    );

    const seen = screen.getAllByText("Seen ✓");
    expect(seen).toHaveLength(1);
    // It sits right after the last user Message.
    const last = container.querySelector("[data-bot-message][data-id=m2]")!;
    expect(last.compareDocumentPosition(seen[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no Seen ✓ when the Bot replied", async () => {
    const server = fakeBotServer();
    mount(server);

    await type("hi");
    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "message", message: said("m2", "assistant", "Hello!") },
      { type: "turnEnded", status: "complete" },
      "end",
    );

    expect(screen.getByText("Hello!")).toBeTruthy();
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});
