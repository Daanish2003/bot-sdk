// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { botClient } from "../../../plugins/bot/client/index";
import type { BotMessage } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-22T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };

const thread = (reactions: { user?: string; bot?: string } = {}): BotMessage[] => [
  {
    id: "m1",
    role: "user",
    text: "thanks!",
    createdAt,
    ...(reactions.bot && { reactions: { bot: { emoji: reactions.bot, at: createdAt } } }),
  },
  {
    id: "m2",
    role: "assistant",
    text: "You're welcome.",
    createdAt,
    ...(reactions.user && { reactions: { user: { emoji: reactions.user, at: createdAt } } }),
  },
];

function mount(messages: BotMessage[], reacted: unknown[] = []) {
  const router = {
    bot: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns: [] })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .handler(({ input }) => ({
          id: input.id,
          role: "user" as const,
          text: input.text,
          createdAt: new Date(),
        })),
      react: os.input(z.custom<unknown>()).handler(({ input }) => {
        reacted.push(input);
      }),
      routine: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
      checkIn: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
      helper: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
      secret: { list: os.handler(() => []) },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), {
      fetch,
      messages: {},
      plugins: [botClient()],
    }),
  );
}

const emojiButton = (container: HTMLElement, emoji: string) =>
  [...container.querySelectorAll<HTMLElement>("[data-emoji]")].find(
    (button) => button.dataset.emoji === emoji,
  ) ?? null;

const chips = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-reaction]")].map(
    (chip) =>
      `${chip.closest("[data-reactions]")?.previousElementSibling?.getAttribute("data-id")}:${chip.dataset.reaction}:${chip.textContent}`,
  );

describe("reactions", () => {
  it("offers the emoji bar on the Bot's Messages only, and sends the one tapped", async () => {
    const reacted: unknown[] = [];
    const { container } = mount(thread(), reacted);

    await waitFor(() => expect(container.querySelector("[data-bot-message]")).not.toBeNull());
    expect(container.querySelectorAll("[data-reaction-bar]")).toHaveLength(1);
    fireEvent.click(emojiButton(container, "🎉")!);

    await waitFor(() => expect(reacted).toHaveLength(1));
    expect(reacted[0]).toMatchObject({ botId: "b2", messageId: "m2", emoji: "🎉" });
  });

  it("shows each side's emoji as a chip on its Message", async () => {
    const { container } = mount(thread({ user: "👍", bot: "❤️" }));

    await waitFor(() => expect(chips(container)).toHaveLength(2));
    expect(chips(container)).toEqual(["m1:bot:❤️", "m2:user:👍"]);
  });

  it("takes the user's emoji off when it is tapped again", async () => {
    const reacted: unknown[] = [];
    const { container } = mount(thread({ user: "👍" }), reacted);

    await waitFor(() => expect(emojiButton(container, "👍")).not.toBeNull());
    expect(emojiButton(container, "👍")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(emojiButton(container, "👍")!);

    await waitFor(() => expect(reacted).toHaveLength(1));
    expect(reacted[0]).toMatchObject({ messageId: "m2", emoji: null });
  });

  it("shows no chips on a Message with no reactions", async () => {
    const { container } = mount(thread());

    await waitFor(() => expect(container.querySelector("[data-bot-message]")).not.toBeNull());
    expect(container.querySelector("[data-reactions]")).toBeNull();
  });
});
