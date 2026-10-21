// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotSecret } from "../../../plugins/bot/shared/secret";
import type { BotMessage, BotSendEvent } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const at = (minute: number) => new Date(`2026-10-21T09:${String(minute).padStart(2, "0")}:00.000Z`);
const ada = { id: "b1", name: "Ada", model: "anthropic:claude-sonnet-5-5", createdAt: at(0) };

const asking: BotMessage = {
  id: "m2",
  role: "assistant",
  text: "I need a token to push.",
  createdAt: at(2),
  secret: { type: "secret", name: "GITHUB_TOKEN", why: "To push to your repository." },
};
const messages: BotMessage[] = [
  { id: "m1", role: "user", text: "push my changes", createdAt: at(1) },
  asking,
];

/** A stand-in for the server's `bot` router that holds `secrets` and records every call. */
function fakeBotServer(secrets: BotSecret[], { refuseSave = false } = {}) {
  let saveAttempts = 0;
  const sent: unknown[] = [];
  const saved: unknown[] = [];
  const deleted: string[] = [];
  const router = {
    bot: {
      get: os.handler(() => ({
        bot: { ...ada, turnStatus: null },
        messages,
        turns: [],
        summaries: [],
        warmings: [],
      })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string() }).loose())
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(({ input }) => {
          sent.push(input);
          return (async function* (): AsyncGenerator<BotSendEvent> {})();
        }),
      warm: os.handler(() => ({ warmed: false as const, skipped: "still_warm" as const })),
      routine: { list: os.handler(() => []) },
      checkIn: { list: os.handler(() => []) },
      helper: { list: os.handler(() => []) },
      review: { list: os.handler(() => []) },
      secret: {
        list: os.handler(() => secrets),
        save: os
          .input(z.object({ botId: z.string(), name: z.string(), value: z.string() }))
          .handler(({ input }) => {
            saveAttempts += 1;
            if (refuseSave) throw new Error("refused");
            saved.push(input);
            secrets.push({ name: input.name, createdAt: at(3) });
          }),
        delete: os.input(z.object({ name: z.string() })).handler(({ input }) => {
          deleted.push(input.name);
          secrets.splice(
            secrets.findIndex((secret) => secret.name === input.name),
            1,
          );
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return {
    fetch,
    sent,
    saved,
    deleted,
    get saveAttempts() {
      return saveAttempts;
    },
  };
}

function mount(server: ReturnType<typeof fakeBotServer>) {
  return render(
    providerFor(createElement(BotConversation, { botId: "b1" }), {
      fetch: server.fetch,
      messages: {},
    }),
  );
}

describe("the Secret card", () => {
  it("asks for the Secret, saves through secret.save and never the message path, and becomes its divider", async () => {
    const server = fakeBotServer([]);
    mount(server);

    const card = await screen.findByRole("group", { name: "Ada asks for GITHUB_TOKEN" });
    expect(within(card).getByText("To push to your repository.")).toBeTruthy();
    expect(within(card).getByText("Ada gets only the name, never the value")).toBeTruthy();
    const field = within(card).getByLabelText("Secret value") as HTMLInputElement;
    expect(field.type).toBe("password");
    const save = within(card).getByRole("button", { name: "Save secret" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(field, { target: { value: "ghp_secret" } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(server.saved).toEqual([{ botId: "b1", name: "GITHUB_TOKEN", value: "ghp_secret" }]),
    );
    expect(server.sent).toEqual([]);
    const divider = await screen.findByText("Saved secret GITHUB_TOKEN");
    expect(divider).toBeTruthy();
    expect(screen.queryByLabelText("Secret value")).toBeNull();
    expect(document.body.textContent).not.toContain("ghp_secret");
  });

  it("keeps the typed value when the save is refused", async () => {
    const server = fakeBotServer([], { refuseSave: true });
    mount(server);
    const card = await screen.findByRole("group", { name: "Ada asks for GITHUB_TOKEN" });
    const field = within(card).getByLabelText("Secret value") as HTMLInputElement;

    fireEvent.change(field, { target: { value: "ghp_secret" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save secret" }));

    await waitFor(() => expect(server.saveAttempts).toBe(1));
    await waitFor(() => expect(screen.getByLabelText("Secret value")).toBe(field));
    expect(field.value).toBe("ghp_secret");
  });

  it("shows the divider at once for a Secret saved since the request", async () => {
    mount(fakeBotServer([{ name: "GITHUB_TOKEN", createdAt: at(3) }]));

    expect(await screen.findByText("Saved secret GITHUB_TOKEN")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save secret" })).toBeNull();
  });
});

describe("the Secrets popover", () => {
  it("lists each Secret's name and date with Delete, and says they are shared and never shown", async () => {
    const server = fakeBotServer([
      { name: "GITHUB_TOKEN", createdAt: new Date("2026-10-20T09:00:00.000Z") },
      { name: "NPM_TOKEN", createdAt: new Date("2026-10-21T09:00:00.000Z") },
    ]);
    mount(server);

    fireEvent.click(await screen.findByRole("button", { name: "Secrets 2" }));

    const list = await screen.findByRole("list", { name: "Secrets" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-secret"))).toEqual([
      "GITHUB_TOKEN",
      "NPM_TOKEN",
    ]);
    expect(within(rows[0]!).getByText(/^saved .*2026/)).toBeTruthy();
    expect(screen.getByText("Shared by all your Bots. Values are never shown.")).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Delete GITHUB_TOKEN" }));

    await waitFor(() => expect(server.deleted).toEqual(["GITHUB_TOKEN"]));
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Secrets" })).getAllByRole("listitem"),
      ).toHaveLength(1),
    );
  });
});
