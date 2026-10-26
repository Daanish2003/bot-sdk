// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotMessage } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-22T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };
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
    bots: {
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
    providerFor(createElement(BotConversation, { botId: ada.id, controls }), {
      fetch,
      messages: {},
    }),
  );
}

const imageId = "0199c8a0-0000-7000-8000-000000000002";
const withImage: BotMessage = {
  ...sent,
  control: {
    kind: "files",
    files: [
      { id: fileId, name: "report.csv", size: 2048, mediaType: "text/csv" },
      { id: imageId, name: "chart.png", size: 4096, mediaType: "image/png" },
    ],
  },
};

describe("the files card", () => {
  it("shows an image as a thumbnail that zooms on click, and other files stay links only", async () => {
    const { container } = mount([withImage]);

    await waitFor(() => expect(container.querySelector("[data-files-card]")).not.toBeNull());
    const inline = `http://localhost/api/chat/bot-files/${imageId}/inline`;
    const thumb = container.querySelector<HTMLImageElement>(`[data-thumbnail="${imageId}"] img`)!;
    expect(thumb.getAttribute("src")).toBe(inline);
    expect(container.querySelector(`[data-thumbnail="${fileId}"]`)).toBeNull();
    // Its download link stays.
    expect(container.querySelector(`a[data-file="${imageId}"]`)!.getAttribute("href")).toBe(
      `http://localhost/api/chat/bot-files/${imageId}`,
    );

    expect(document.querySelector("[data-zoomed]")).toBeNull();
    fireEvent.click(container.querySelector(`[data-thumbnail="${imageId}"]`)!);
    await waitFor(() => expect(document.querySelector("[data-zoomed]")).not.toBeNull());
    expect(document.querySelector("[data-zoomed]")!.getAttribute("src")).toBe(inline);
  });

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
