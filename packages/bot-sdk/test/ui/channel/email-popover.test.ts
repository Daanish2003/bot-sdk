// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { assistantClient } from "../../../plugins/assistant/client/index";
import { botClient } from "../../../plugins/bot/client/index";
import type { BotMessage } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { channelClient } from "../../../plugins/channel/client/index";
import { EmailPopover } from "../../../plugins/channel/ui/email-popover";
import { modelsClient } from "../../../plugins/models/client/index";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plugins = [modelsClient(), assistantClient(), channelClient(), botClient()];
const first = "ada.k3x9q2mz@bots.example";
const second = "ada.p7w4n1cv@bots.example";

/**
 * A stand-in for the server's `channel` router, holding one Bot's address and the Channel its next
 * Bot-initiated Message goes by, and recording rotations.
 */
function fakeChannelServer(nextChannel: "web" | "email" = "web") {
  let address = first;
  const rotated: unknown[] = [];
  const router = {
    channel: {
      email: {
        address: os
          .input(z.object({ botId: z.string() }))
          .handler(() => ({ address, nextChannel })),
        rotate: os.input(z.object({ botId: z.string() })).handler(({ input }) => {
          rotated.push(input);
          address = second;
          return { address };
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, rotated };
}

function openPopover(server: ReturnType<typeof fakeChannelServer>) {
  render(
    providerFor(createElement(EmailPopover, { botId: "b1" }), {
      fetch: server.fetch,
      messages: {},
      plugins,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Email" }));
}

describe("EmailPopover", () => {
  it("shows the Bot's address once opened, and copies it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    openPopover(fakeChannelServer());

    expect(await screen.findByText(first)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(first));
  });

  it("asks to confirm a rotation, and Cancel keeps the address", async () => {
    const server = fakeChannelServer();
    openPopover(server);
    await screen.findByText(first);

    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));

    expect(screen.getByRole("alert").textContent).toContain(
      "Rotate? The old address stops working at once.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(server.rotated).toEqual([]);
    expect(screen.getByText(first)).toBeTruthy();
  });

  it("rotates once confirmed and shows the new address", async () => {
    const server = fakeChannelServer();
    openPopover(server);
    await screen.findByText(first);

    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));

    expect(await screen.findByText(second)).toBeTruthy();
    expect(server.rotated).toEqual([{ botId: "b1" }]);
    expect(screen.queryByText(first)).toBeNull();
    expect(screen.getByText("Next Bot-initiated Message goes by web")).toBeTruthy();
  });

  it("says which Channel the next Bot-initiated Message goes by", async () => {
    openPopover(fakeChannelServer("email"));

    expect(await screen.findByText("Next Bot-initiated Message goes by Email")).toBeTruthy();
  });
});

describe("Messages that went by email", () => {
  it("marks the user's Message via email and the Bot's emailed, and web ones with nothing", async () => {
    const at = (minute: number) => new Date(`2026-10-22T09:0${minute}:00.000Z`);
    const messages: BotMessage[] = [
      { id: "m1", role: "user", text: "from web", createdAt: at(1) },
      { id: "m2", role: "user", text: "from my inbox", createdAt: at(2), channel: "email" },
      { id: "m3", role: "assistant", text: "emailed back", createdAt: at(3), channel: "email" },
      { id: "m4", role: "assistant", text: "web only", createdAt: at(4) },
    ];
    const list = os.handler(() => []);
    const handler = new RPCHandler({
      bot: {
        get: os.handler(() => ({
          bot: {
            id: "b1",
            name: "Ada",
            model: "openai:gpt-5.6",
            createdAt: at(0),
            turnStatus: null,
          },
          messages,
          turns: [],
          summaries: [],
          warmings: [],
        })),
        send: os.handler((): BotMessage => ({}) as BotMessage),
        warm: os.handler(() => ({ warmed: false as const, skipped: "still_warm" as const })),
        routine: { list },
        checkIn: { list },
        helper: { list },
        review: { list },
        secret: { list },
      },
    });
    render(
      providerFor(createElement(BotConversation, { botId: "b1" }), {
        fetch: async (request: Request) =>
          (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
          new Response(null, { status: 404 }),
        messages: {},
      }),
    );

    await screen.findByText("from my inbox");
    expect(screen.getAllByText("via email")).toHaveLength(1);
    const pill = screen.getByText("via email");
    expect(pill.previousElementSibling?.textContent).toBe("from my inbox");
    // The Bot's emailed Message gets "✉ emailed"; its web-only one gets no pill.
    expect(screen.getAllByText("✉ emailed")).toHaveLength(1);
    expect(screen.getByText("✉ emailed").previousElementSibling?.textContent).toContain(
      "emailed back",
    );
  });
});
