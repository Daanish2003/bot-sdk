// @vitest-environment jsdom
import type { BotMessage } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-30T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

const thread: BotMessage[] = [
  { id: "m1", role: "user", text: "From the phone", createdAt, channel: "telegram" },
  { id: "m2", role: "user", text: "By mail", createdAt, channel: "email" },
  { id: "m3", role: "user", text: "From the web", createdAt },
  { id: "m4", role: "assistant", text: "Emailed back", createdAt, channel: "email" },
];

function mount(messages: BotMessage[]) {
  const router = {
    bots: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns: [] })),
      stop: os.handler(() => {}),
      send: os.input(z.custom<unknown>()).handler(() => {}),
    },
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    checkIns: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    helpers: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    secrets: { list: os.handler(() => []) },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }),
  );
}

describe("the Channel mark", () => {
  it('marks a user Message from a messaging Channel "via <platform>", and no web Message', async () => {
    const { container } = mount(thread);

    await waitFor(() => expect(container.querySelectorAll("[data-bot-message]")).toHaveLength(4));
    const marks = [...container.querySelectorAll("[data-channel-pill]")].map(
      (mark) => mark.textContent,
    );
    // In thread order: the web Message has none.
    expect(marks).toEqual(["via telegram", "via email", "✉ emailed"]);
  });
});
