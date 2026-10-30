// @vitest-environment jsdom
import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ChannelsPopover } from "../../src/channel/channels-popover";
import { channelClient } from "@botsdk/client";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const at = new Date("2026-10-30T09:00:00.000Z");
const none: ChannelAccountRow = { platform: "telegram", fields: ["token"], account: null };
const connected: ChannelAccountRow = {
  ...none,
  account: { handle: "@ada_bot", status: "active", reason: null, createdAt: at, updatedAt: at },
};
const rejected: ChannelAccountRow = {
  ...none,
  account: { ...connected.account!, status: "needs_attention", reason: "Unauthorized" },
};

/**
 * A stand-in for the server's `channels.accounts` procedures over one Telegram row, recording saves
 * and removes; a save of the token `bad` is refused as the platform would.
 */
function fakeAccountsServer(row: ChannelAccountRow) {
  let current = row;
  const saved: unknown[] = [];
  const removed: unknown[] = [];
  const input = z.object({ botId: z.string(), platform: z.string() });
  const router = {
    channels: {
      accounts: {
        list: os.input(z.object({ botId: z.string() })).handler(() => [current]),
        save: os
          .input(input.extend({ credentials: z.record(z.string(), z.string()) }))
          .handler(({ input: given }) => {
            saved.push(given);
            if (given.credentials.token === "bad") {
              throw new ORPCError("BAD_REQUEST", {
                data: { code: "error.channelCredentialsRejected" },
              });
            }
            current = connected;
            return current;
          }),
        remove: os.input(input).handler(({ input: given }) => {
          removed.push(given);
          current = none;
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, saved, removed };
}

function openPopover(server: ReturnType<typeof fakeAccountsServer>) {
  render(
    providerFor(createElement(ChannelsPopover, { botId: "b1" }), {
      features: [channelClient()],
      fetch: server.fetch,
      messages: {},
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Channels/ }));
}

const telegramRow = async () => {
  const list = await screen.findByRole("list", { name: "Channels" });
  return within(list).getByText("Telegram").closest("li")!;
};

describe("ChannelsPopover", () => {
  it("offers Add with a password field and the @BotFather hint, and saves the token", async () => {
    const server = fakeAccountsServer(none);
    openPopover(server);
    const row = await telegramRow();

    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    const field = within(row).getByLabelText("Bot token") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(within(row).getByText(/@BotFather/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "123:abc" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    expect(await within(row).findByText("@ada_bot")).toBeTruthy();
    expect(server.saved).toEqual([
      { botId: "b1", platform: "telegram", credentials: { token: "123:abc" } },
    ]);
    expect(within(row).queryByLabelText("Bot token")).toBeNull();
  });

  it("keeps the field open when the platform rejects the token", async () => {
    const server = fakeAccountsServer(none);
    openPopover(server);
    const row = await telegramRow();

    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    fireEvent.change(within(row).getByLabelText("Bot token"), { target: { value: "bad" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(server.saved).toHaveLength(1));
    expect(within(row).getByLabelText("Bot token")).toBeTruthy();
    expect(within(row).queryByText("@ada_bot")).toBeNull();
  });

  it("shows a connected account's handle, and removes it", async () => {
    const server = fakeAccountsServer(connected);
    openPopover(server);
    const row = await telegramRow();

    expect(within(row).getByText("@ada_bot")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Remove Telegram" }));

    expect(await within(row).findByRole("button", { name: "Add" })).toBeTruthy();
    expect(server.removed).toEqual([{ botId: "b1", platform: "telegram" }]);
  });

  it("warns on the button and in the row when an account needs attention, and fixes it", async () => {
    const server = fakeAccountsServer(rejected);
    openPopover(server);
    const row = await telegramRow();

    expect(screen.getByRole("img", { name: "A Channel needs attention" })).toBeTruthy();
    expect(within(row).getByRole("alert").textContent).toBe("Needs attention: Unauthorized");
    fireEvent.click(within(row).getByRole("button", { name: "Fix" }));
    fireEvent.change(within(row).getByLabelText("Bot token"), { target: { value: "123:new" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(row).queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("img", { name: "A Channel needs attention" })).toBeNull();
  });

  it("shows no warning while every account listens", async () => {
    openPopover(fakeAccountsServer(connected));
    await telegramRow();

    expect(screen.queryByRole("img", { name: "A Channel needs attention" })).toBeNull();
  });
});
