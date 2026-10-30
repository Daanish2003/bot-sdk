// @vitest-environment jsdom
import type { BotSdkClient } from "@botsdk/client";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { safetyFetchMs } from "@botsdk/react/bot/bot-sync";
import { dateFormat } from "@botsdk/react/intl";
import type { ChatRouter } from "@botsdk/react/provider";
import { BotSidebar } from "../../src/bot/bot-sidebar";
import { RoomConversation } from "../../src/bot/room-conversation";
import { providerFor, renderWrapped, untranslated } from "@ai-chat/test-support/fake-dictionary";

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
