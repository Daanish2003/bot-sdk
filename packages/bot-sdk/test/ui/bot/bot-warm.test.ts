// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotMessage, BotWarming } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const createdAt = new Date("2026-10-21T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "anthropic:claude-sonnet-5-5", createdAt };

const said = (id: string, role: BotMessage["role"], text: string, at = createdAt): BotMessage => ({
  id,
  role,
  text,
  createdAt: at,
});

/** A stand-in for the server's `bot` router that counts the warms asked of it. */
function fakeBotServer(messages: BotMessage[], warmings: BotWarming[] = []) {
  const warms: unknown[] = [];
  const router = {
    bot: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns: [], warmings })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .handler(({ input }) => ({
          id: input.id,
          role: "user" as const,
          text: input.text,
          createdAt: new Date(),
        })),
      warm: os.input(z.object({ botId: z.string() })).handler(({ input }) => {
        warms.push(input);
        return { warmed: false as const, skipped: "still_warm" as const };
      }),
      routine: { list: os.handler(() => []) },
      checkIn: { list: os.handler(() => []) },
      helper: { list: os.handler(() => []) },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, warms };
}

function mount(server: ReturnType<typeof fakeBotServer>, botId: string) {
  return render(
    providerFor(createElement(BotConversation, { botId }), { fetch: server.fetch, messages: {} }),
  );
}

describe("warming the Bot's cache", () => {
  it("asks the server to warm when the Conversation opens", async () => {
    const server = fakeBotServer([said("m1", "user", "hi")]);

    mount(server, "open-bot");

    await waitFor(() => expect(server.warms).toEqual([{ botId: "open-bot" }]));
  });

  it("asks on the first keystroke of a draft, but at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = fakeBotServer([said("m1", "user", "hi")]);
    mount(server, "typing-bot");
    await waitFor(() => expect(server.warms).toHaveLength(1));
    const box = await screen.findByRole("textbox");
    const type = (value: string) => fireEvent.change(box, { target: { value } });

    // Within the minute of opening: the keystroke asks nothing more.
    vi.setSystemTime(Date.now() + 30_000);
    type("h");
    await Promise.resolve();
    expect(server.warms).toHaveLength(1);

    // A minute on, a new draft's first keystroke asks; the next keystrokes of it do not.
    type("");
    vi.setSystemTime(Date.now() + 31_000);
    type("h");
    type("he");
    type("hel");
    await waitFor(() => expect(server.warms).toHaveLength(2));
    await Promise.resolve();
    expect(server.warms).toHaveLength(2);
  });

  it("shows a muted line with the cost before the first Message saved after the warm", async () => {
    const warmedAt = new Date("2026-10-21T10:00:00.000Z");
    const server = fakeBotServer(
      [
        said("m1", "user", "hi"),
        said("m2", "assistant", "hello"),
        said("m3", "user", "back", new Date("2026-10-21T11:00:00.000Z")),
      ],
      [{ id: "w1", at: warmedAt, costMicros: 2_500 }],
    );
    const { container } = mount(server, "line-bot");

    await screen.findByText("Cache warmed · $0.0025");

    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-warming]"),
    ].map((row) => (row.dataset.warming ? `warming:${row.textContent}` : row.textContent));
    expect(rows).toEqual(["hi", "hello", "warming:Cache warmed · $0.0025", "back"]);
  });
});
