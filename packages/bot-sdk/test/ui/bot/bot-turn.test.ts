// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { rpcError } from "../../../core/server/rpc-error";
import { en } from "../../../core/shared/i18n";
import type { BotMessage, TurnStatus } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";
import { changeLog, hint, settle, stubEventSource } from "./fake-change-log";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-17T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

/**
 * A stand-in for the server's `bot` router: `bots.get` answers with `messages`, the Turn statuses and
 * the change log's cursor, `conversations.changes` with the log, and `bots.send` saves the user's Message and
 * starts a Turn, as the server does. The test moves the Turn on with `emit` and `endTurn`, and the
 * `changed` hint says so, as the `/events` route does.
 */
function fakeBotServer(messages: BotMessage[] = []) {
  const log = changeLog();
  let turnStatus: TurnStatus | "running" | null = null;
  // The status of the Turn that took the user's last Message.
  let userTurnStatus: TurnStatus | "running" | null = null;
  // Whether a Routine's Turn runs after the user's, so the user's ending leaves the latest running.
  let otherTurn = false;
  let tick = 0;
  const sends: unknown[] = [];
  const stops: unknown[] = [];
  // The error the next send is refused with, before the Message is saved.
  let refusal: Error | undefined;
  // While set, each `bots.get` reads the Messages at once but answers only once it resolves.
  let held: Promise<void> | undefined;
  const turnChange = (id: string, status: TurnStatus | "running") =>
    log.record("turn", id, { id, status, startedAt: createdAt, endedAt: null });
  const save = (message: BotMessage) => {
    messages.push(message);
    log.record("message", message.id, message);
  };
  const router = {
    conversations: {
      changes: os
        .input(z.object({ conversationId: z.string(), since: z.number() }))
        .handler(({ input }) => log.since(input.since)),
    },
    bots: {
      get: os.handler(async () => {
        const read = {
          bot: { ...ada, turnStatus, userTurnStatus },
          conversationId: "c1",
          messages: [...messages],
          lastSeq: log.last,
        };
        await held;
        return read;
      }),
      stop: os.input(z.object({ botId: z.string() })).handler(({ input }) => {
        stops.push(input);
      }),
      send: os
        .input(
          z.object({
            botId: z.string(),
            id: z.string(),
            text: z.string(),
            timeZone: z.string().optional(),
          }),
        )
        .handler(({ input }) => {
          sends.push(input);
          if (refusal) {
            const refused = refusal;
            refusal = undefined;
            throw refused;
          }
          const saved = {
            id: input.id,
            role: "user" as const,
            text: input.text,
            createdAt: new Date(createdAt.getTime() + ++tick * 1000),
          };
          save(saved);
          turnStatus = userTurnStatus = "running";
          turnChange(`t${tick}`, "running");
          return saved;
        }),
    },
  };
  const handler = new RPCHandler(router);
  // How many of the next send requests fail as a dropped network does: `fetch` rejects.
  let dropRequests = 0;
  const dropped: string[] = [];
  const droppedAt: number[] = [];
  const fetch = async (request: Request) => {
    if (dropRequests > 0 && request.url.endsWith("/bots/send")) {
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
    log,
    sends,
    /** The bodies of the requests `dropNext` failed. */
    dropped,
    /** When each of those requests was made, in ms. */
    droppedAt,
    stops,
    /** What `bots.get` says of the latest Turn from now on, as a Turn run elsewhere moves on. */
    setTurnStatus: (status: TurnStatus | "running" | null) => {
      turnStatus = status;
      userTurnStatus = status;
    },
    /** Starts a Routine's Turn on the server, after the user's: the latest Turn now runs. */
    startOtherTurn: () => {
      otherTurn = true;
      turnStatus = "running";
      turnChange("t-other", "running");
    },
    /** What `bots.get` says of the Turn that took the user's last Message, when another Turn ran since. */
    setUserTurnStatus: (status: TurnStatus | "running" | null) => {
      userTurnStatus = status;
    },
    /** Fails the next `count` send requests on the network, before the server sees them. */
    dropNext: (count = 1) => {
      dropRequests = count;
    },
    /** Refuses the next send with `error`, as the server does before saving the Message. */
    refuseNext: (error: Error) => {
      refusal = error;
    },
    /** Holds every `bots.get` answer until the returned release is called. */
    holdGets: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
    },
    /** The Bot sends Messages; the hint reaches the page, which reads them. */
    emit: async (...sent: [id: string, role: BotMessage["role"], text: string][]) => {
      for (const [id, role, text] of sent) {
        save({ ...said(id, role, text), createdAt: new Date(createdAt.getTime() + ++tick * 1000) });
      }
      await hint();
    },
    /** The Turn ends; the hint reaches the page. */
    endTurn: async (status: TurnStatus) => {
      userTurnStatus = status;
      if (!otherTurn) turnStatus = status;
      turnChange("t-end", status);
      await hint();
    },
    /** Another tab sends a Message and its Turn starts; the hint reaches this page. */
    sendElsewhere: async (id: string, text: string) => {
      save({ ...said(id, "user", text), createdAt: new Date(createdAt.getTime() + ++tick * 1000) });
      turnStatus = userTurnStatus = "running";
      turnChange("t-elsewhere", "running");
      await hint();
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
        {
          botId: ada.id,
          id: expect.stringMatching(uuidv7Shape),
          text: "hello",
          timeZone: expect.any(String),
        },
      ]),
    );
    await settle();
    expect(bubbles(container)).toEqual([["user", "hello"]]);
    const { id } = server.sends[0] as { id: string };
    expect(container.querySelector(`[data-bot-message][data-id="${id}"]`)).toBeTruthy();
  });

  it("sends the browser's IANA time zone with each Message", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Tokyo",
    } as Intl.ResolvedDateTimeFormatOptions);
    const server = fakeBotServer();
    mount(server);

    await type("first");
    await type("second");

    await waitFor(() => expect(server.sends).toHaveLength(2));
    expect((server.sends as { timeZone?: string }[]).map((send) => send.timeZone)).toEqual([
      "Asia/Tokyo",
      "Asia/Tokyo",
    ]);
  });

  it("shows only the sent Messages, the user's on the right and the Bot's on the left", async () => {
    const server = fakeBotServer([said("m0", "user", "earlier")]);
    const { container } = mount(server);
    await screen.findByText("earlier");

    await type("hi");
    await waitFor(() => expect(server.sends).toHaveLength(1));
    await server.emit(["m2", "assistant", "On it…"], ["m3", "assistant", "Done."]);
    await server.endTurn("complete");

    expect(bubbles(container)).toEqual([
      ["user", "earlier"],
      ["user", "hi"],
      ["assistant", "On it…"],
      ["assistant", "Done."],
    ]);
    const sides = [...container.querySelectorAll<HTMLElement>("[data-bot-message]")].map(
      (bubble) => (bubble.parentElement!.className.includes("self-end") ? "right" : "left"),
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

    await settle();
    await server.endTurn("complete");
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
  });

  it("shows Seen ✓ under the last user Message only, after a quiet Turn", async () => {
    const server = fakeBotServer();
    const { container } = mount(server);

    await type("ok");
    await settle();
    expect(screen.queryByText("Seen ✓")).toBeNull();
    await server.endTurn("complete");
    expect(screen.getAllByText("Seen ✓")).toHaveLength(1);

    await type("brb");
    await settle();
    await server.endTurn("complete");

    const seen = screen.getAllByText("Seen ✓");
    expect(seen).toHaveLength(1);
    // It sits right after the last user Message.
    const { id } = server.sends[1] as { id: string };
    const last = container.querySelector(`[data-bot-message][data-id="${id}"]`)!;
    expect(last.compareDocumentPosition(seen[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no Seen ✓ when the Bot replied", async () => {
    const server = fakeBotServer();
    mount(server);

    await type("hi");
    await waitFor(() => expect(server.sends).toHaveLength(1));
    await server.emit(["m2", "assistant", "Hello!"]);
    await server.endTurn("complete");

    expect(screen.getByText("Hello!")).toBeTruthy();
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});

describe("a refetch during a send", () => {
  it("doesn't drop the synced Messages when a bot.get that started before the send answers after them", async () => {
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
    await waitFor(() => expect(server.sends).toHaveLength(1));
    await server.emit(["m2", "assistant", "Hello!"]);
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
    await settle();
    expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

    await type("and one more thing");

    expect(bubbles(container)).toEqual([
      ["user", "hi"],
      ["user", "and one more thing"],
    ]);
    await waitFor(() =>
      expect(server.sends).toEqual([
        {
          botId: ada.id,
          id: expect.stringMatching(uuidv7Shape),
          text: "hi",
          timeZone: expect.any(String),
        },
        {
          botId: ada.id,
          id: expect.stringMatching(uuidv7Shape),
          text: "and one more thing",
          timeZone: expect.any(String),
        },
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
    await server.endTurn("complete");
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
    await settle();
    await server.endTurn("complete");
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
    await settle();
    await server.endTurn("error");

    const failed = screen.getByText("Couldn't reply");
    expect(failed.className).toContain("text-muted-foreground");
    const { id } = server.sends[0] as { id: string };
    const sent = container.querySelector(`[data-bot-message][data-id="${id}"]`)!;
    expect(sent.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Seen ✓")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });

  it("shows nothing after a stopped Turn", async () => {
    const server = fakeBotServer();
    mount(server);

    await type("hi");
    await settle();
    await server.endTurn("stopped");

    expect(screen.queryByText("Couldn't reply")).toBeNull();
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});

describe("a quiet background run after the user's Message", () => {
  it("reads the user's Message's own Turn, not the run: no Seen ✓ after a stopped one", async () => {
    const server = fakeBotServer([said("m1", "user", "hi")]);
    // A Routine's quiet run, the latest Turn, ended complete after the user's Turn was stopped.
    server.setTurnStatus("complete");
    server.setUserTurnStatus("stopped");
    mount(server);

    await screen.findByText("hi");
    expect(screen.queryByText("Seen ✓")).toBeNull();
    expect(screen.queryByText("Couldn't reply")).toBeNull();
  });

  it("shows Couldn't reply after the user's failed Turn, not Seen ✓", async () => {
    const server = fakeBotServer([said("m1", "user", "hi")]);
    server.setTurnStatus("complete");
    server.setUserTurnStatus("error");
    mount(server);

    expect(await screen.findByText("Couldn't reply")).toBeTruthy();
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});

describe("a Turn that starts as the user's ends", () => {
  it("keeps showing ••• for a Routine run already running when the user's Turn ends", async () => {
    const server = fakeBotServer();
    mount(server);

    await type("hi");
    await settle();
    // A Routine's fire started the next Turn while the user's was ending.
    server.startOtherTurn();
    await server.endTurn("complete");

    expect(await screen.findByRole("status", { name: "Typing" })).toBeTruthy();
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

    await settle();
    await server.endTurn("stopped");
    expect(screen.queryByRole("button", { name: "■ Stop" })).toBeNull();
  });
});

describe("a Turn another tab started", () => {
  it("shows its Messages and its end from the change log, with no send and no polling", async () => {
    const server = fakeBotServer([said("m0", "user", "earlier")]);
    const { container } = mount(server);
    await screen.findByText("earlier");
    const before = server.log.calls.length;

    await server.sendElsewhere("m1", "from the other tab");
    expect(bubbles(container)).toEqual([
      ["user", "earlier"],
      ["user", "from the other tab"],
    ]);
    expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

    await server.emit(["m2", "assistant", "Hello!"]);
    await server.endTurn("complete");

    expect(bubbles(container)).toEqual([
      ["user", "earlier"],
      ["user", "from the other tab"],
      ["assistant", "Hello!"],
    ]);
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
    // One fetch per hint, and nothing else.
    expect(server.log.calls.length - before).toBeLessThanOrEqual(3);
    // The cursor moved on with each change.
    expect(server.log.calls.at(-1)).toBeGreaterThan(server.log.calls[0]!);
  });
});
