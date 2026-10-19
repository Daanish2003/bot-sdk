// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotHelper, HelperStatus } from "../../../plugins/bot/shared/helper";
import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
});

const createdAt = new Date("2026-10-19T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-5.6", createdAt };

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

const helper = (afterMessageId: string, extra: Partial<BotHelper> = {}): BotHelper => ({
  id: "h1",
  type: "general",
  task: "Count the files in /home/user/shared.\nThen report.",
  gist: "Count the files in /home/user/shared.",
  status: "running",
  steps: 2,
  latest: "shell: ls /home/user/shared",
  report: null,
  startedAt: createdAt,
  afterMessageId,
  ...extra,
});

/** A stand-in for the server's `bot` router, with the Helpers a test gives it. */
function mount(messages: BotMessage[], helpers: BotHelper[]) {
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
      helper: {
        list: os
          .input(z.object({ botId: z.string() }))
          .handler(() => helpers.map((h) => ({ ...h }))),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }),
  );
}

const card = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-helper]")!;

describe("a Helper in the Conversation", () => {
  it("shows a card right after the Bot Message of the Turn that started it", async () => {
    const { container } = mount(
      [
        said("m1", "user", "Count them"),
        said("m2", "assistant", "On it."),
        said("m3", "user", "ok"),
      ],
      [helper("m2")],
    );

    await screen.findByText("Count the files in /home/user/shared.");
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-helper]"),
    ].map((row) => (row.dataset.helper ? "helper" : row.textContent));
    expect(rows).toEqual(["Count them", "On it.", "helper", "ok"]);
  });

  it("shows its type, and while live its Step and latest tool call, with the task behind a click", async () => {
    const { container } = mount([said("m1", "assistant", "On it.")], [helper("m1")]);

    await screen.findByText("General Helper");
    expect(card(container).textContent).toContain("Working");
    expect(card(container).textContent).toContain("step 2 · shell: ls /home/user/shared");
    expect(card(container).querySelector(".animate-spin")).not.toBeNull();
    expect(card(container).textContent).not.toContain("Task:");

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(card(container).textContent).toContain("Task: Count the files in /home/user/shared.");
    expect(card(container).textContent).not.toContain("Report:");
  });

  it("names a Computer-use Helper", async () => {
    mount([said("m1", "assistant", "On it.")], [helper("m1", { type: "computer_use" })]);

    await screen.findByText("Computer-use Helper");
  });

  it.each([
    ["waiting", "Needs you", true],
    ["complete", "Done", false],
    ["error", "Failed", false],
    ["stopped", "Stopped", false],
  ] as [HelperStatus, string, boolean][])(
    "shows %s as %s, with the report once it ended",
    async (status, label, live) => {
      const { container } = mount(
        [said("m1", "assistant", "On it.")],
        [helper("m1", { status, report: live ? null : "There are 3 files." })],
      );

      await screen.findByText(label);
      expect(card(container).dataset.status).toBe(status);
      expect(card(container).querySelector(".animate-spin")).toBeNull();
      expect(card(container).textContent?.includes("step 2")).toBe(live);
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      expect(card(container).textContent?.includes("Report: There are 3 files.")).toBe(!live);
    },
  );

  it("updates the same card in place when the Helper ends, with no finished line", async () => {
    const helpers = [helper("m1")];
    const { container } = mount([said("m1", "assistant", "On it.")], helpers);
    await screen.findByText("Working");
    const before = card(container);

    helpers[0] = { ...helpers[0]!, status: "complete", latest: null, report: "There are 3 files." };

    await waitFor(() => expect(card(container).dataset.status).toBe("complete"), { timeout: 5000 });
    expect(card(container)).toBe(before);
    expect(container.querySelectorAll("[data-helper]")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/finished/i);
    expect(card(container).textContent).toContain("Done");
    expect(card(container).textContent).not.toContain("step 2");
  });
});
