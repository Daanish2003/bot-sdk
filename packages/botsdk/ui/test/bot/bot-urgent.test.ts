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
  { id: "m1", role: "assistant", text: "Server is down.", createdAt, urgent: true },
  { id: "m2", role: "assistant", text: "Back up now.", createdAt },
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

describe("urgent Messages", () => {
  it("marks an urgent Message in the thread and no other", async () => {
    const { container } = mount(thread);

    await waitFor(() => expect(container.querySelectorAll("[data-bot-message]")).toHaveLength(2));
    const marks = container.querySelectorAll("[data-urgent-mark]");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe("Urgent");
    expect(
      marks[0]?.parentElement?.querySelector("[data-bot-message]")?.getAttribute("data-id"),
    ).toBe("m1");
  });
});
