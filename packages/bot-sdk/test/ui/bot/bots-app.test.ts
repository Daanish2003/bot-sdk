// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import type { ChatRouter } from "../../../core/client/react/provider";
import { safetyFetchMs } from "../../../plugins/bot/client/react/bot-sync";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { BotSidebar } from "../../../plugins/bot/ui/bot-sidebar";
import type { ListedModel } from "../../../plugins/models/shared/models";
import { providerFor, renderWrapped, untranslated } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const createdAt = new Date("2026-10-17T09:00:00.000Z");
const inbox = { id: "b1", name: "Inbox Manager", model: "openai:gpt-5.6", createdAt };
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };
const idle = { turnStatus: null, lastMessage: null };

const listed = (id: string, label: string): ListedModel => ({
  id,
  label,
  provider: "openai",
  modelId: id.slice("openai:".length),
  images: true,
  pdfs: true,
  tools: true,
  contextWindow: null,
  maxOutputTokens: null,
  onHostCredentials: false,
  reasoning: { efforts: [], off: false, defaultEffort: null },
});

function seed(queryClient: QueryClient, client: BotSdkClient) {
  queryClient.setQueryData(client.orpc.bot.list.queryKey(), [
    { ...inbox, ...idle },
    { ...ada, ...idle },
  ]);
  queryClient.setQueryData(client.orpc.models.list.queryKey(), {
    models: [listed("openai:gpt-5.5", "GPT-5.5"), listed("openai:gpt-5.6", "GPT-5.6")],
    defaultModel: "openai:gpt-5.6",
    defaultBackgroundModel: null,
    imageModels: [],
    defaultImageModel: null,
    webSearchOnHost: false,
  });
  queryClient.setQueryData(client.orpc.bot.get.queryKey({ input: { botId: ada.id } }), {
    bot: { ...ada, turnStatus: null, userTurnStatus: null },
    conversationId: "c1",
    messages: [],
    turns: [],
    summaries: [],
    warmings: [],
    lastSeq: 0,
  });
}

/** Mounts `ui` with English text, the seeded Bots and Models, and `fetch` as the network. */
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

describe("the Bots sidebar", () => {
  it("lists each Bot with an initials avatar on a colour from its name", () => {
    const { container } = mount(createElement(BotSidebar));

    expect(screen.getByText("Inbox Manager")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    const avatars = [...container.querySelectorAll<HTMLElement>("[data-slot=bot-avatar]")];
    expect(avatars.map((avatar) => avatar.textContent)).toEqual(["IM", "A"]);
    const colours = avatars.map((avatar) => avatar.style.background);
    expect(colours[0]).toBeTruthy();
    expect(colours[0]).not.toBe(colours[1]);
  });

  it("links back to the assistant", () => {
    mount(createElement(BotSidebar));

    expect(screen.getByText("Assistant")).toBeTruthy();
  });

  it("doesn't poll the Bots while one runs: the change log and focus refresh it (ADR 0026)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = [{ ...ada, turnStatus: "running" as const, lastMessage: null }];
    let asked = 0;
    const handler = new RPCHandler({
      bot: {
        list: os.handler(() => {
          asked++;
          return running;
        }),
      },
    });
    const fetch = async (request: Request) =>
      (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
      new Response(null, { status: 404 });
    render(
      providerFor(createElement(BotSidebar), {
        fetch,
        messages: {},
        seed: (queryClient, client) =>
          queryClient.setQueryData(client.orpc.bot.list.queryKey(), running),
      }),
    );
    expect(screen.getByText("Working…")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(10));
    const before = asked;

    await act(() => vi.advanceTimersByTimeAsync(5 * safetyFetchMs));

    expect(asked).toBe(before);
  });

  it("translates every label", () => {
    const html = renderWrapped(createElement(BotSidebar), { seed });

    expect(untranslated(html, ["Inbox Manager", "Ada", "IM", "A"])).toEqual([]);
  });
});

describe("the New Bot dialog", () => {
  it("creates a Bot with a name and the default Model, then opens it", async () => {
    const bodies: unknown[] = [];
    const navigate = vi.fn();
    const fetch = async (request: Request) => {
      // Only the create is answered; the seeded lists' refetches never are.
      if (!request.url.endsWith("/bot/create")) return new Promise<Response>(() => {});
      bodies.push(await request.json());
      return new Response(
        JSON.stringify({ json: { ...ada, id: "b9", name: "Scout", createdAt: "2026-10-17" } }),
        { headers: { "content-type": "application/json" } },
      );
    };
    mount(createElement(BotSidebar), { fetch, navigate });

    fireEvent.click(screen.getByRole("button", { name: "New Bot" }));
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("GPT-5.6");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Scout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "bots", id: "b9" }));
    expect(bodies).toEqual([{ json: { name: "Scout", model: "openai:gpt-5.6" } }]);
  });

  it("won't create a Bot without a name", () => {
    mount(createElement(BotSidebar));

    fireEvent.click(screen.getByRole("button", { name: "New Bot" }));

    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("a Bot's Conversation", () => {
  it("opens empty, with the Bot's name and avatar", () => {
    mount(createElement(BotConversation, { botId: ada.id }));

    expect(screen.getByRole("heading", { name: "Ada" })).toBeTruthy();
    expect(screen.getByText("No messages yet")).toBeTruthy();
  });

  it("shows a Summary card before the first Message saved after it", () => {
    const message = (id: string, role: "user" | "assistant", text: string, minute: number) => ({
      id,
      role,
      text,
      createdAt: new Date(2026, 9, 21, 14, minute),
    });
    render(
      providerFor(createElement(BotConversation, { botId: ada.id }), {
        messages: {},
        seed: (queryClient, client) => {
          seed(queryClient, client);
          queryClient.setQueryData(client.orpc.bot.get.queryKey({ input: { botId: ada.id } }), {
            bot: { ...ada, turnStatus: null, userTurnStatus: null },
            conversationId: "c1",
            messages: [
              message("m1", "user", "Plan my week", 0),
              message("m2", "assistant", "Here's your week.", 1),
              message("m3", "user", "Thanks", 30),
            ],
            turns: [],
            summaries: [
              {
                id: "s1",
                kind: "away",
                at: new Date(2026, 9, 21, 14, 10),
                text: "The user planned their week.",
                kept: [message("m2", "assistant", "Here's your week.", 1)],
              },
            ],
            warmings: [],
            lastSeq: 0,
          });
        },
      }),
    );

    const card = screen.getByRole("button", { name: "Summarized while you were away · 14:10" });
    const order = [...document.querySelectorAll("[data-bot-message], [data-summary]")].map(
      (node) => node.getAttribute("data-id") ?? node.getAttribute("data-summary"),
    );
    expect(order).toEqual(["m1", "m2", "s1", "m3"]);
    expect(card).toBeTruthy();
  });
});
