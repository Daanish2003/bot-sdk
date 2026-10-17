// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { Toaster } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { rpcError } from "../../../core/server/rpc-error";
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
  // The error the next send is refused with, before its stream starts.
  let refusal: Error | undefined;
  // While set, each `bot.get` reads the Messages at once but answers only once it resolves.
  let held: Promise<void> | undefined;
  const router = {
    bot: {
      get: os.handler(async () => {
        const read = { bot: ada, messages: [...messages] };
        await held;
        return read;
      }),
      send: os
        .input(z.object({ botId: z.string(), text: z.string() }))
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(async function* ({ input }) {
          sends.push(input);
          if (refusal) {
            const refused = refusal;
            refusal = undefined;
            throw refused;
          }
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
    /** Refuses the next send with `error`, as the server does before saving the Message. */
    refuseNext: (error: Error) => {
      refusal = error;
    },
    /** Holds every `bot.get` answer until the returned release is called. */
    holdGets: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
    },
    /** Streams `events` to the open send, then lets the client read them. */
    stream: async (...events: (BotSendEvent | "end")[]) => {
      await act(async () => {
        for (const event of events) push(event);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
  };
}

function mount(
  server: ReturnType<typeof fakeBotServer>,
  seed?: (queryClient: QueryClient) => void,
) {
  return render(
    createElement(
      Fragment,
      null,
      providerFor(createElement(BotConversation, { botId: ada.id }), {
        fetch: server.fetch,
        messages: {},
        seed,
      }),
      // The toast shows in the Toaster, which the page mounts once.
      createElement(Toaster),
    ),
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

describe("a refetch during a send", () => {
  it("doesn't drop the streamed Messages when a bot.get that started before the send answers after them", async () => {
    const server = fakeBotServer([said("m0", "user", "earlier")]);
    let queryClient: QueryClient | undefined;
    const { container } = mount(server, (client) => (queryClient = client));
    await screen.findByText("earlier");

    // A refetch (a window focus, say) reads the Conversation before the send, and answers late.
    const release = server.holdGets();
    await act(async () => {
      void queryClient!.refetchQueries();
    });
    await type("hi");
    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "message", message: said("m2", "assistant", "Hello!") },
    );
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(bubbles(container)).toEqual([
      ["user", "earlier"],
      ["user", "hi"],
      ["assistant", "Hello!"],
    ]);
  });
});

describe("a refused send", () => {
  it.each([
    [
      "409, a Turn is running",
      rpcError("CONFLICT", "error.turnRunning", "A Turn is still running"),
      "Your Bot is still replying. Wait for it to finish, then send again.",
    ],
    [
      "402, out of Quota",
      rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "Quota spent"),
      "You've used this window's Quota",
    ],
  ])("on %s removes the bubble, puts the text back and says why", async (_, error, why) => {
    const server = fakeBotServer([said("m0", "user", "earlier")]);
    server.refuseNext(error);
    const { container } = mount(server);
    await screen.findByText("earlier");

    await type("hello?");

    await waitFor(() => expect(document.body.textContent).toContain(why));
    expect(bubbles(container)).toEqual([["user", "earlier"]]);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe(
      "hello?",
    );
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
  });
});

describe("a Turn that didn't reply", () => {
  it("shows a muted Couldn't reply under the user's Message after an error Turn, with no retry", async () => {
    const server = fakeBotServer();
    const { container } = mount(server);

    await type("hi");
    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "turnEnded", status: "error" },
      "end",
    );

    const failed = screen.getByText("Couldn't reply");
    expect(failed.className).toContain("text-muted-foreground");
    const sent = container.querySelector("[data-bot-message][data-id=m1]")!;
    expect(sent.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Seen ✓")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });

  it("shows nothing after a stopped Turn", async () => {
    const server = fakeBotServer();
    mount(server);

    await type("hi");
    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "turnEnded", status: "stopped" },
      "end",
    );

    expect(screen.queryByText("Couldn't reply")).toBeNull();
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});
