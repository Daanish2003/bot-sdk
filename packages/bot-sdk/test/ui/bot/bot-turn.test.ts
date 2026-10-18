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
import { en } from "../../../core/shared/i18n";
import type { BotMessage, BotSendEvent, TurnStatus } from "../../../plugins/bot/shared/turn";
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
 * A stand-in for the server's `bot` router: `bot.get` answers with `messages` and the latest Turn's
 * status, and each `bot.send` streams the events the test pushes, until it ends or drops the stream.
 */
function fakeBotServer(messages: BotMessage[] = []) {
  // Events pushed before the send's request arrives wait here for it.
  const queue: (BotSendEvent | "end" | "drop")[] = [];
  let wake = () => {};
  let turnStatus: TurnStatus | "running" | null = null;
  const push = (event: BotSendEvent | "end" | "drop") => {
    queue.push(event);
    wake();
  };
  const sends: unknown[] = [];
  const stops: unknown[] = [];
  // The error the next send is refused with, before its stream starts.
  let refusal: Error | undefined;
  // While set, each `bot.get` reads the Messages at once but answers only once it resolves.
  let held: Promise<void> | undefined;
  const router = {
    bot: {
      get: os.handler(async () => {
        const read = { bot: { ...ada, turnStatus }, messages: [...messages] };
        await held;
        return read;
      }),
      stop: os.input(z.object({ botId: z.string() })).handler(({ input }) => {
        stops.push(input);
      }),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }))
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
            if (next === "drop") throw new Error("The connection dropped");
            yield next;
          }
        }),
    },
  };
  const handler = new RPCHandler(router);
  // How many of the next send requests fail as a dropped network does: `fetch` rejects.
  let dropRequests = 0;
  const dropped: string[] = [];
  const droppedAt: number[] = [];
  const fetch = async (request: Request) => {
    if (dropRequests > 0 && request.url.endsWith("/bot/send")) {
      dropRequests--;
      droppedAt.push(Date.now());
      dropped.push(await request.text());
      throw new TypeError("Failed to fetch");
    }
    return (
      (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
      new Response(null, { status: 404 })
    );
  };
  return {
    fetch,
    sends,
    /** The bodies of the requests `dropNext` failed. */
    dropped,
    /** When each of those requests was made, in ms. */
    droppedAt,
    stops,
    /** What `bot.get` says of the latest Turn from now on, as the server's Turn moves on. */
    setTurnStatus: (status: TurnStatus | "running" | null) => {
      turnStatus = status;
    },
    /** Fails the next `count` send requests on the network, before the server sees them. */
    dropNext: (count = 1) => {
      dropRequests = count;
    },
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
    stream: async (...events: (BotSendEvent | "end" | "drop")[]) => {
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

const uuidv7Shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    await waitFor(() =>
      expect(server.sends).toEqual([
        { botId: ada.id, id: expect.stringMatching(uuidv7Shape), text: "hello" },
      ]),
    );
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

describe("sending while the Bot works", () => {
  it("sends mid-Turn and shows the Message at once, with no refusal", async () => {
    const server = fakeBotServer();
    const { container } = mount(server);
    await type("hi");
    await server.stream({ type: "message", message: said("m1", "user", "hi") });
    expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

    await type("and one more thing");

    expect(bubbles(container)).toEqual([
      ["user", "hi"],
      ["user", "and one more thing"],
    ]);
    await waitFor(() =>
      expect(server.sends).toEqual([
        { botId: ada.id, id: expect.stringMatching(uuidv7Shape), text: "hi" },
        { botId: ada.id, id: expect.stringMatching(uuidv7Shape), text: "and one more thing" },
      ]),
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("");
    expect(screen.getByRole("button", { name: "■ Stop" })).toBeTruthy();
  });

  it("has no Turn-running refusal to show", () => {
    expect(Object.keys(en)).not.toContain("error.turnRunning");
  });
});

describe("a send that fails on the network", () => {
  it("retries with the id of the failed attempt, and the next send gets a fresh one", async () => {
    const server = fakeBotServer();
    mount(server);
    server.dropNext();

    await type("first");
    await waitFor(() => expect(server.sends).toHaveLength(1));
    await server.stream(
      { type: "message", message: said("m1", "user", "first") },
      { type: "turnEnded", status: "complete" },
      "end",
    );
    await type("second");
    await waitFor(() => expect(server.sends).toHaveLength(2));

    const [first, second] = server.sends as { id: string; text: string }[];
    expect(first).toMatchObject({ text: "first", id: expect.stringMatching(uuidv7Shape) });
    expect(server.dropped).toHaveLength(1);
    expect(server.dropped[0]).toContain(first!.id);
    expect(second).toMatchObject({ text: "second", id: expect.stringMatching(uuidv7Shape) });
    expect(second!.id).not.toBe(first!.id);
  });

  it("waits a little longer before each retry", async () => {
    const server = fakeBotServer();
    mount(server);
    server.dropNext(2);

    await type("hi");
    await waitFor(() => expect(server.sends).toHaveLength(1), { timeout: 3_000 });

    const [first, second, third] = [...server.droppedAt, Date.now()];
    expect(second! - first!).toBeGreaterThanOrEqual(200);
    expect(third! - second!).toBeGreaterThan(second! - first!);
  });

  it("gives the text back when every attempt fails, and sending it again reuses the same id", async () => {
    const server = fakeBotServer();
    const { container } = mount(server);
    server.dropNext(3);

    await type("hello?");
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    await waitFor(() => expect(composer.value).toBe("hello?"), { timeout: 3_000 });
    expect(bubbles(container)).toEqual([]);
    expect(server.sends).toEqual([]);

    // The server may have saved it from an attempt whose answer was lost: the resend must re-join it.
    await type("hello?");
    await waitFor(() => expect(server.sends).toHaveLength(1));
    const { id } = (server.sends as { id: string }[])[0]!;
    expect(server.dropped).toHaveLength(3);
    for (const body of server.dropped) expect(body).toContain(id);

    // Once it is saved, the same text again is a new Message.
    await server.stream(
      { type: "message", message: said("m1", "user", "hello?") },
      { type: "turnEnded", status: "complete" },
      "end",
    );
    await type("hello?");
    await waitFor(() => expect(server.sends).toHaveLength(2));
    expect((server.sends as { id: string }[])[1]!.id).not.toBe(id);
  });
});

describe("a refused send", () => {
  it("on 402, out of Quota, removes the bubble, puts the text back and says why", async () => {
    const why = "You've used this window's Quota";
    const server = fakeBotServer([said("m0", "user", "earlier")]);
    server.refuseNext(rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "Quota spent"));
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

describe("stopping a Turn", () => {
  it("shows ■ Stop while Working…, even for a Turn running in another tab, and calls bot.stop", async () => {
    const server = fakeBotServer();
    server.setTurnStatus("running");
    mount(server);

    fireEvent.click(await screen.findByRole("button", { name: "■ Stop" }));

    await waitFor(() => expect(server.stops).toEqual([{ botId: ada.id }]));
  });

  it("shows ■ Stop for a send in flight, and not once the Turn has ended", async () => {
    const server = fakeBotServer();
    mount(server);
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByRole("button", { name: "■ Stop" })).toBeNull();

    await type("hi");
    expect(screen.getByRole("button", { name: "■ Stop" })).toBeTruthy();

    await server.stream(
      { type: "message", message: said("m1", "user", "hi") },
      { type: "turnEnded", status: "stopped" },
      "end",
    );
    expect(screen.queryByRole("button", { name: "■ Stop" })).toBeNull();
  });
});

describe("a send whose stream drops", () => {
  it("follows the Turn by polling bot.get every 2 s while it runs, until it ends", async () => {
    const messages: BotMessage[] = [];
    const server = fakeBotServer(messages);
    const { container } = mount(server);
    await screen.findByRole("textbox", { name: "Message" });

    await type("hi");
    // The server saved the Message and runs the Turn off the request, so it goes on without the tab.
    messages.push(said("m1", "user", "hi"));
    server.setTurnStatus("running");
    await server.stream({ type: "message", message: said("m1", "user", "hi") }, "drop");
    expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

    // The Turn sends a Message and ends while the tab isn't streaming.
    messages.push(said("m2", "assistant", "Hello!"));
    server.setTurnStatus("complete");
    await waitFor(() => expect(screen.getByText("Hello!")).toBeTruthy(), { timeout: 4_000 });

    expect(bubbles(container)).toEqual([
      ["user", "hi"],
      ["assistant", "Hello!"],
    ]);
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
    // A dropped stream isn't a refusal: the composer stays empty.
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("");
  });
});
