// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { assistantClient } from "../../../plugins/assistant/client/index";
import { botClient } from "../../../plugins/bot/client/index";
import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-22T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };
const fileId = "0199c8a0-0000-7000-8000-000000000001";

const sent: BotMessage = {
  id: "m2",
  role: "assistant",
  text: "Here is the report.",
  createdAt,
  control: {
    kind: "files",
    files: [{ id: fileId, name: "report.csv", size: 2048, mediaType: "text/csv" }],
  },
};

function mount(
  messages: BotMessage[],
  controls?: Parameters<typeof BotConversation>[0]["controls"],
) {
  const router = {
    bot: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns: [] })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(async function* () {}),
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
      plugins: [assistantClient(), botClient()],
    }),
  );
}

describe("the files card", () => {
  it("shows a download link with the name and size of each file under its Message", async () => {
    const { container } = mount([sent]);

    await waitFor(() => expect(container.querySelector("[data-files-card]")).not.toBeNull());
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-files-card]"),
    ].map((row) => (row.dataset.filesCard === undefined ? row.dataset.id : "card"));
    expect(rows).toEqual(["m2", "card"]);
    const link = container.querySelector<HTMLAnchorElement>(`[data-file="${fileId}"]`)!;
    expect(link.getAttribute("href")).toBe(`http://localhost/api/chat/bot-files/${fileId}`);
    expect(link.getAttribute("download")).toBe("report.csv");
    expect(link.textContent).toContain("report.csv");
    expect(link.textContent).toContain("2 KB");
  });

  it("draws with the Host's renderer for the files kind when it gives one", async () => {
    const { container } = mount([sent], {
      files: ({ card }) => createElement("p", { "data-mine": "" }, `${card.files.length} files`),
    });

    await waitFor(() => expect(container.querySelector("[data-mine]")).not.toBeNull());
    expect(container.querySelector("[data-files-card]")).toBeNull();
    expect(container.querySelector("[data-mine]")!.textContent).toBe("1 files");
  });
});
