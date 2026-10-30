// @vitest-environment jsdom
import type { BotSdkClient } from "@botsdk/client";
import type { BotMessage } from "@botsdk/client/bot/turn";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { safetyFetchMs } from "@botsdk/react/bot/bot-sync";
import { dateFormat } from "@botsdk/react/intl";
import type { ChatRouter } from "@botsdk/react/provider";
import { BotSidebar } from "../../src/bot/bot-sidebar";
import { RoomConversation } from "../../src/bot/room-conversation";
import { providerFor, renderWrapped, untranslated } from "@ai-chat/test-support/fake-dictionary";
import { changeLog, hint, stubEventSource } from "./fake-change-log";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const createdAt = new Date("2026-10-30T09:00:00.000Z");
const bot = (id: string, name: string) => ({
  id,
  name,
  model: "openai:gpt-6-luna",
  createdAt,
  pausedAt: null,
  turnStatus: null,
  lastMessage: null,
});
const scout = bot("b1", "Scout");
const writer = bot("b2", "Writer");
const ops = bot("b3", "Ops");
const member = (from: { id: string; name: string }, lead = false) => ({
  botId: from.id,
  name: from.name,
  lead,
  pausedAt: null,
  status: null,
});
const launch = {
  conversationId: "r1",
  name: "Launch",
  members: [member(scout, true), member(writer)],
  createdAt,
  lastMessageAt: createdAt,
};

function seed(queryClient: QueryClient, client: BotSdkClient) {
  queryClient.setQueryData(client.orpc.bots.list.queryKey(), [scout, writer, ops]);
  queryClient.setQueryData(client.orpc.rooms.list.queryKey(), [launch]);
  queryClient.setQueryData(
    client.orpc.rooms.get.queryKey({ input: { conversationId: launch.conversationId } }),
    {
      room: launch,
      messages: [
        { id: "m1", role: "user", text: "Find me three venues.", createdAt },
        { id: "m2", role: "assistant", text: "On it.", createdAt, authorBotId: scout.id },
        { id: "m3", role: "assistant", text: "An old note.", createdAt, authorBotId: "gone" },
      ],
      lastSeq: 3,
    },
  );
}

/** Mounts `ui` with English text, the seeded Bots and Room, and `fetch` as the network. */
function mount(
  ui: ReactElement,
  {
    fetch = () => new Promise<Response>(() => {}),
    navigate = () => {},
  }: {
    fetch?: (request: Request) => Promise<Response>;
    navigate?: ChatRouter["navigate"];
  } = {},
) {
  return render(providerFor(ui, { seed, fetch, navigate, messages: {} }));
}

describe("the Rooms section", () => {
  it("lists the user's Rooms under the Bots, with + New Room", () => {
    mount(createElement(BotSidebar));

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getByText("Launch")).toBeTruthy();
    expect(within(rooms).getByText("2 Bots")).toBeTruthy();
    expect(within(rooms).getByRole("button", { name: "New Room" })).toBeTruthy();
  });

  it("creates a Room with a name and two or more Bots, the first picked the lead, then opens it", async () => {
    const bodies: unknown[] = [];
    const navigate = vi.fn();
    const fetch = async (request: Request) => {
      // Only the create is answered; the seeded lists' refetches never are.
      if (!request.url.endsWith("/rooms/create")) return new Promise<Response>(() => {});
      bodies.push(await request.json());
      return new Response(
        JSON.stringify({
          json: {
            ...launch,
            conversationId: "r9",
            name: "Ship",
            members: [member(writer, true), member(ops)],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    mount(createElement(BotSidebar), { fetch, navigate });

    fireEvent.click(screen.getByRole("button", { name: "New Room" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Room name" }), {
      target: { value: "Ship" },
    });
    const create = within(dialog).getByRole("button", { name: "Create Room" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Writer/ }));
    // One Bot is not a Room.
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /Ops/ }));
    expect(within(dialog).getByRole("button", { name: /Writer/ }).textContent).toContain("lead");
    fireEvent.click(create);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "rooms", id: "r9" }));
    expect(bodies).toEqual([{ json: { name: "Ship", botIds: [writer.id, ops.id] } }]);
  });

  it("translates every label", () => {
    const html = renderWrapped(createElement(BotSidebar), { seed });

    expect(
      untranslated(html, ["Scout", "Writer", "Ops", "Launch", "S", "W", "O", "SC", "WR"]),
    ).toEqual([]);
  });
});

describe("managing a Room", () => {
  const withMembers =
    (members: ReturnType<typeof member>[]) => (queryClient: QueryClient, client: BotSdkClient) => {
      const room = { ...launch, members };
      seed(queryClient, client);
      queryClient.setQueryData(client.orpc.rooms.list.queryKey(), [room]);
      queryClient.setQueryData(
        client.orpc.rooms.get.queryKey({ input: { conversationId: room.conversationId } }),
        { room, messages: [], lastSeq: 0 },
      );
    };
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Room menu" }));
    return screen.getByRole("dialog");
  };

  it("warns on a Room with one Bot left, and allows only adding a Bot or deleting the Room", () => {
    render(
      providerFor(createElement(RoomConversation, { conversationId: "r1" }), {
        seed: withMembers([member(scout, true)]),
        messages: {},
      }),
    );

    expect(screen.getByRole("alert").textContent).toContain("Only Scout is left in this Room");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    const dialog = open();
    expect(
      (within(dialog).getByRole("textbox", { name: "Room name" }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Remove Scout" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Add Writer" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(dialog).getByRole("button", { name: "Delete Room…" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows no warning on a Room with two Bots, and keeps its Bots from being removed", () => {
    mount(createElement(RoomConversation, { conversationId: "r1" }));

    expect(screen.queryByRole("alert")).toBeNull();
    const dialog = open();
    expect(
      (within(dialog).getByRole("button", { name: "Remove Writer" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("renames the Room, adds a Bot, makes another the lead and deletes the Room", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const navigate = vi.fn();
    const fetch = async (request: Request) => {
      const path = new URL(request.url).pathname.split("/rpc/")[1] ?? "";
      if (!path.startsWith("rooms/") || path === "rooms/get" || path === "rooms/list") {
        return new Promise<Response>(() => {});
      }
      calls.push({ path, body: await request.json() });
      return new Response(JSON.stringify({ json: null }), {
        headers: { "content-type": "application/json" },
      });
    };
    render(
      providerFor(createElement(RoomConversation, { conversationId: "r1" }), {
        seed,
        fetch,
        navigate,
        messages: {},
      }),
    );

    const dialog = open();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Room name" }), {
      target: { value: "Ship" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Ops" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(within(dialog).getByRole("button", { name: "Make lead" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Room…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Room" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "bots" }));
    expect(calls).toEqual([
      { path: "rooms/rename", body: { json: { conversationId: "r1", name: "Ship" } } },
      { path: "rooms/addMember", body: { json: { conversationId: "r1", botId: ops.id } } },
      { path: "rooms/setLead", body: { json: { conversationId: "r1", botId: writer.id } } },
      { path: "rooms/delete", body: { json: { conversationId: "r1" } } },
    ]);
  });
});

describe("a Room", () => {
  it("shows each Message with its author's avatar and name, or deleted Bot", () => {
    mount(createElement(RoomConversation, { conversationId: launch.conversationId }));

    expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
    const authors = [...document.querySelectorAll("[data-room-message]")].map(
      (node) => node.querySelector("[data-author]")?.textContent,
    );
    expect(authors).toEqual(["You", "Scout", "deleted Bot"]);
    expect(screen.getByText("On it.")).toBeTruthy();
  });

  it("sends the user's Message to the Room", async () => {
    const bodies: unknown[] = [];
    const fetch = async (request: Request) => {
      if (!request.url.endsWith("/rooms/send")) return new Promise<Response>(() => {});
      bodies.push(await request.json());
      return new Response(
        JSON.stringify({
          json: { id: "m4", role: "user", text: "Thanks.", createdAt: "2026-10-30T09:01:00Z" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    mount(createElement(RoomConversation, { conversationId: launch.conversationId }), { fetch });

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Thanks." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("Thanks.")).toBeTruthy());
    expect(bodies).toEqual([{ json: { conversationId: "r1", text: "Thanks." } }]);
  });

  it("fetches the change log every so often while the user's Message waits for a reply", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fetched = 0;
    const fetch = (request: Request) => {
      if (request.url.endsWith("/conversations/changes")) fetched++;
      return new Promise<Response>(() => {});
    };
    render(
      providerFor(createElement(RoomConversation, { conversationId: launch.conversationId }), {
        fetch,
        messages: {},
        seed: (queryClient, client) => {
          seed(queryClient, client);
          queryClient.setQueryData(
            client.orpc.rooms.get.queryKey({ input: { conversationId: launch.conversationId } }),
            {
              room: launch,
              messages: [{ id: "m1", role: "user", text: "Anyone?", createdAt }],
              lastSeq: 1,
            },
          );
        },
      }),
    );

    await act(() => vi.advanceTimersByTimeAsync(safetyFetchMs + 10));

    expect(fetched).toBe(1);
  });

  it("translates every label", () => {
    const html = renderWrapped(
      createElement(RoomConversation, { conversationId: launch.conversationId }),
      { seed },
    );

    expect(
      untranslated(html, [
        "Launch",
        "Scout",
        "Writer",
        "S",
        "W",
        "SC",
        "WR",
        "Find me three venues.",
        "On it.",
        "An old note.",
        // The time, as the locale formats it in this zone.
        dateFormat("en", { hour: "numeric", minute: "2-digit" }).format(createdAt),
      ]),
    ).toEqual([]);
  });
});

describe("a Room's members", () => {
  it("shows the members as an avatar stack, the lead marked, with a status dot on each", () => {
    render(
      providerFor(createElement(RoomConversation, { conversationId: launch.conversationId }), {
        fetch: () => new Promise<Response>(() => {}),
        messages: {},
        seed: (queryClient, client) => {
          seed(queryClient, client);
          queryClient.setQueryData(
            client.orpc.rooms.get.queryKey({ input: { conversationId: launch.conversationId } }),
            {
              room: {
                ...launch,
                members: [
                  { ...member(scout, true), status: "working" },
                  { ...member(writer), pausedAt: createdAt, status: "paused" },
                  { ...member(ops), status: "queued" },
                  member({ id: "b4", name: "Idle" }),
                ],
              },
              messages: [],
              lastSeq: 0,
            },
          );
        },
      }),
    );

    const members = within(screen.getByRole("list", { name: "Members" })).getAllByRole("listitem");
    expect(members.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Scout, lead, working",
      "Writer, paused",
      "Ops, queued",
      "Idle",
    ]);
    expect(
      members.map((item) => item.querySelector("[data-status]")?.getAttribute("data-status")),
    ).toEqual(["working", "paused", "queued", undefined]);
  });
});

describe("@ autocomplete in a Room's composer", () => {
  const typeIn = (box: HTMLElement, value: string) =>
    fireEvent.change(box, { target: { value, selectionStart: value.length } });

  it("offers the members whose name starts with what follows the @, and picks one with the keys", () => {
    mount(createElement(RoomConversation, { conversationId: launch.conversationId }));
    const box = screen.getByRole("textbox", { name: "Message" });

    typeIn(box, "Hi @");
    const list = screen.getByRole("listbox", { name: "Mention a member" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Scout", "Writer"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect((box as HTMLTextAreaElement).value).toBe("Hi @Writer ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("narrows by the typed name, case-insensitive, and picks on a click", () => {
    mount(createElement(RoomConversation, { conversationId: launch.conversationId }));
    const box = screen.getByRole("textbox", { name: "Message" });

    typeIn(box, "@sc");
    const list = screen.getByRole("listbox", { name: "Mention a member" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Scout"]);
    fireEvent.mouseDown(within(list).getByRole("option", { name: "Scout" }));

    expect((box as HTMLTextAreaElement).value).toBe("@Scout ");
  });

  it("offers nothing for an @ inside a word, or once Escape closes it", () => {
    mount(createElement(RoomConversation, { conversationId: launch.conversationId }));
    const box = screen.getByRole("textbox", { name: "Message" });

    typeIn(box, "bob@s");
    expect(screen.queryByRole("listbox")).toBeNull();
    typeIn(box, "bob @");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes once a member is picked, even when a longer name starts with it, and opens for an @ typed again", () => {
    render(
      providerFor(createElement(RoomConversation, { conversationId: launch.conversationId }), {
        fetch: () => new Promise<Response>(() => {}),
        messages: {},
        seed: (queryClient, client) => {
          seed(queryClient, client);
          queryClient.setQueryData(
            client.orpc.rooms.get.queryKey({ input: { conversationId: launch.conversationId } }),
            {
              room: {
                ...launch,
                members: [...launch.members, member({ id: "b5", name: "Scout Two" })],
              },
              messages: [],
              lastSeq: 0,
            },
          );
        },
      }),
    );
    const box = screen.getByRole("textbox", { name: "Message" });

    typeIn(box, "@");
    fireEvent.keyDown(box, { key: "Escape" });
    typeIn(box, "");
    typeIn(box, "@");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Scout" }));
    // "Scout Two" starts with "Scout ", yet the picked mention is done.
    expect(screen.queryByRole("listbox")).toBeNull();
    // A cleared draft (sent) opens the list for its next @.
    typeIn(box, "");
    typeIn(box, "@");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

describe("a Room's members, kept in step", () => {
  beforeEach(stubEventSource);
  afterEach(() => vi.unstubAllGlobals());

  it("reads the Room again when a Turn in it starts or ends, so the status dots follow", async () => {
    const log = changeLog();
    const state = { status: null as "working" | null };
    const router = {
      conversations: {
        changes: os
          .input(z.object({ conversationId: z.string(), since: z.number() }))
          .handler(({ input }) => log.since(input.since)),
      },
      rooms: {
        get: os.handler(() => ({
          room: { ...launch, members: [{ ...member(scout, true), status: state.status }] },
          messages: [],
          lastSeq: log.last,
        })),
      },
    };
    const handler = new RPCHandler(router);
    const fetch = async (request: Request) =>
      (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
      new Response(null, { status: 404 });
    render(
      providerFor(createElement(RoomConversation, { conversationId: launch.conversationId }), {
        fetch,
        messages: {},
      }),
    );
    await screen.findByRole("listitem", { name: "Scout, lead" });

    state.status = "working";
    log.record("turn", "t1", { id: "t1", status: "running", startedAt: createdAt, endedAt: null });
    await hint();

    await screen.findByRole("listitem", { name: "Scout, lead, working" });
  });
});

describe("handoffs in a Room", () => {
  /** Mounts the Room with `messages` among three members. */
  const mountWith = (messages: BotMessage[]) =>
    render(
      providerFor(createElement(RoomConversation, { conversationId: launch.conversationId }), {
        fetch: () => new Promise<Response>(() => {}),
        messages: {},
        seed: (queryClient, client) => {
          seed(queryClient, client);
          queryClient.setQueryData(
            client.orpc.rooms.get.queryKey({ input: { conversationId: launch.conversationId } }),
            {
              room: { ...launch, members: [member(scout, true), member(writer), member(ops)] },
              messages,
              lastSeq: messages.length,
            },
          );
        },
      }),
    );

  it("shows a relay line on a Bot Message that hands work on, with its hop", () => {
    mountWith([
      {
        id: "m1",
        role: "assistant",
        text: "@Writer @Ops, over to you.",
        createdAt,
        authorBotId: scout.id,
        handoff: { to: [writer.id, ops.id], hops: 2 },
      },
      { id: "m2", role: "assistant", text: "Noted.", createdAt, authorBotId: writer.id },
    ]);

    const [handedOn, plain] = document.querySelectorAll("[data-room-message]");
    expect(handedOn?.querySelector("[data-relay]")?.textContent).toBe("→ @Writer, @Ops · hop 2/3");
    expect(plain?.querySelector("[data-relay]")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("shows a divider where the chain stopped at the hop limit, and no relay line there", () => {
    mountWith([
      {
        id: "m1",
        role: "assistant",
        text: "@Writer, again.",
        createdAt,
        authorBotId: scout.id,
        handoff: { to: [writer.id], hops: 4 },
      },
    ]);

    expect(screen.getByRole("separator").textContent).toBe(
      "Scout → Writer stopped after 3 hops; waiting for you.",
    );
    expect(document.querySelector("[data-relay]")).toBeNull();
  });

  it("translates every label", () => {
    const html = renderWrapped(
      createElement(RoomConversation, { conversationId: launch.conversationId }),
      {
        seed: (queryClient, client) => {
          seed(queryClient, client);
          queryClient.setQueryData(
            client.orpc.rooms.get.queryKey({ input: { conversationId: launch.conversationId } }),
            {
              room: launch,
              messages: [
                {
                  id: "m1",
                  role: "assistant",
                  text: "@Writer, go.",
                  createdAt,
                  authorBotId: scout.id,
                  handoff: { to: [writer.id], hops: 1 },
                },
                {
                  id: "m2",
                  role: "assistant",
                  text: "@Scout, back.",
                  createdAt,
                  authorBotId: writer.id,
                  handoff: { to: [scout.id], hops: 4 },
                },
              ],
              lastSeq: 2,
            },
          );
        },
      },
    );

    expect(
      untranslated(html, [
        "Launch",
        "Scout",
        "Writer",
        "S",
        "W",
        "SC",
        "WR",
        "@Writer, go.",
        "@Scout, back.",
        "@Writer",
        "@Scout",
        dateFormat("en", { hour: "numeric", minute: "2-digit" }).format(createdAt),
      ]),
    ).toEqual([]);
  });
});
