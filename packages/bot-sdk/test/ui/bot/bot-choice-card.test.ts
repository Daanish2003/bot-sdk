// @vitest-environment jsdom
import { ORPCError, os } from "@orpc/server";
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

const asked = (other: boolean, answer?: { text: string; other: boolean }): BotMessage => ({
  id: "m2",
  role: "assistant",
  text: "Which color?",
  createdAt,
  control: { kind: "choice", options: ["Red", "Blue"], other, ...(answer && { answer }) },
});

function mount(
  messages: BotMessage[],
  {
    chosen = [],
    refuse = false,
    controls,
  }: {
    chosen?: unknown[];
    refuse?: boolean;
    controls?: Parameters<typeof BotConversation>[0]["controls"];
  } = {},
) {
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
      choose: os.input(z.custom<unknown>()).handler(({ input }) => {
        chosen.push(input);
        if (refuse) {
          throw new ORPCError("CONFLICT", { data: { code: "error.choiceAnswered" } });
        }
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
    providerFor(createElement(BotConversation, { botId: ada.id, controls }), {
      fetch,
      messages: {},
      plugins: [botClient()],
    }),
  );
}

describe("the choice card", () => {
  it("shows a button per option under the Message, and sends the one picked", async () => {
    const chosen: unknown[] = [];
    const { container } = mount([asked(false)], { chosen });

    await waitFor(() => expect(container.querySelector("[data-choice]")).not.toBeNull());
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-choice]"),
    ].map((row) => (row.dataset.choice === undefined ? row.dataset.id : "card"));
    expect(rows).toEqual(["m2", "card"]);
    expect([...container.querySelectorAll("[data-option]")].map((el) => el.textContent)).toEqual([
      "Red",
      "Blue",
    ]);
    expect(container.querySelector("input")).toBeNull();

    fireEvent.click(container.querySelector("[data-option='Blue']")!);

    await waitFor(() => expect(chosen).toHaveLength(1));
    expect(chosen[0]).toMatchObject({
      botId: "b2",
      messageId: "m2",
      answer: { option: "Blue" },
    });
  });

  it("sends the free text of Other when the Bot allows it", async () => {
    const chosen: unknown[] = [];
    const { container } = mount([asked(true)], { chosen });

    await waitFor(() => expect(container.querySelector("input")).not.toBeNull());
    const send = container.querySelector<HTMLButtonElement>("button[type=submit]")!;
    expect(send.disabled).toBe(true);
    fireEvent.change(container.querySelector("input")!, { target: { value: " Green " } });
    fireEvent.click(send);

    await waitFor(() => expect(chosen).toHaveLength(1));
    expect(chosen[0]).toMatchObject({ answer: { other: "Green" } });
  });

  it("shows the answered state with no buttons once answered", async () => {
    const { container } = mount([asked(true, { text: "Red", other: false })]);

    await waitFor(() => expect(container.querySelector("[data-state=answered]")).not.toBeNull());
    expect(container.querySelector("[data-state=answered]")!.textContent).toContain("Red");
    expect(container.querySelector("[data-option]")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("draws with the Host's renderer for the choice kind when it gives one", async () => {
    const { container } = mount([asked(false)], {
      controls: {
        choice: ({ card }) => createElement("p", { "data-mine": "" }, `${card.options.length}`),
      },
    });

    await waitFor(() => expect(container.querySelector("[data-mine]")).not.toBeNull());
    expect(container.querySelector("[data-choice]")).toBeNull();
  });
});
