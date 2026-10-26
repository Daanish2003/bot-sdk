// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotMessage, BotTurnStatus } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { BotSidebar } from "../../../plugins/bot/ui/bot-sidebar";
import { providerFor } from "../fake-dictionary";
import { changeLog, hint, settle, stubEventSource } from "./fake-change-log";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-17T09:00:00.000Z");
const bots = [
  { id: "b1", name: "Inbox Manager", model: "openai:gpt-6-luna", createdAt },
  { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt },
];

const said = (id: string, role: BotMessage["role"], text: string): BotMessage => ({
  id,
  role,
  text,
  createdAt,
});

type ServerBot = {
  messages?: BotMessage[];
  turnStatus?: BotTurnStatus | null;
  lastMessage?: { text: string; at: Date } | null;
};

/**
 * A stand-in for the server's `bot` router. `bots.list` and `bots.get` answer from `state`, `bots.send`
 * saves the user's Message to Ada and starts her Turn, and `bots.changes` answers from her change log.
 */
function fakeBotServer(state: Record<string, ServerBot> = {}) {
  const log = changeLog();
  let tick = 0;
  const at = () => new Date(createdAt.getTime() + ++tick * 1000);
  const turnChange = (status: BotTurnStatus) =>
    log.record("turn", "t1", { id: "t1", status, startedAt: createdAt, endedAt: null });
  const router = {
    bots: {
      list: os.handler(() =>
        bots.map((bot) => ({
          ...bot,
          turnStatus: state[bot.id]?.turnStatus ?? null,
          lastMessage: state[bot.id]?.lastMessage ?? null,
        })),
      ),
      get: os.input(z.object({ botId: z.string() })).handler(({ input }) => ({
        bot: {
          ...bots.find((bot) => bot.id === input.botId)!,
          turnStatus: state[input.botId]?.turnStatus ?? null,
          // Only the user's Turns run here, so the latest Turn is the one that took their last Message.
          userTurnStatus: state[input.botId]?.turnStatus ?? null,
        },
        conversationId: `c-${input.botId}`,
        messages: state[input.botId]?.messages ?? [],
        lastSeq: input.botId === "b2" ? log.last : 0,
      })),
      changes: os
        .input(z.object({ botId: z.string(), since: z.number() }))
        .handler(({ input }) => log.since(input.since)),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .handler(({ input }) => {
          const saved = { id: input.id, role: "user" as const, text: input.text, createdAt: at() };
          const ada = (state.b2 ??= {});
          ada.messages = [...(ada.messages ?? []), saved];
          ada.turnStatus = "running";
          log.record("message", saved.id, saved);
          turnChange("running");
          return saved;
        }),
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return {
    fetch,
    /** Ada sends a Message; the hint reaches an open page. */
    say: async (id: string, text: string) => {
      const ada = (state.b2 ??= {});
      const saved = { ...said(id, "assistant", text), createdAt: at() };
      ada.messages = [...(ada.messages ?? []), saved];
      log.record("message", id, saved);
      await hint();
    },
    /** Ada's Turn ends; the hint reaches an open page. */
    end: async (status: BotTurnStatus) => {
      (state.b2 ??= {}).turnStatus = status;
      turnChange(status);
      await hint();
    },
  };
}

/** The sidebar beside a Conversation that a button switches between the two Bots. */
function Harness() {
  const [botId, setBotId] = useState("b2");
  return createElement(
    Fragment,
    null,
    createElement(BotSidebar),
    createElement("button", { onClick: () => setBotId("b1") }, "open Inbox"),
    createElement("button", { onClick: () => setBotId("b2") }, "open Ada"),
    createElement(BotConversation, { botId }),
  );
}

async function mount(server: ReturnType<typeof fakeBotServer>) {
  const view = render(providerFor(createElement(Harness), { fetch: server.fetch, messages: {} }));
  await settle();
  return view;
}

async function type(text: string) {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

const bubbles = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-bot-message]")].map((bubble) => [
    bubble.dataset.role,
    bubble.textContent,
  ]);

describe("a Turn that outlives the Conversation view", () => {
  it("keeps running, and its sidebar row keeps saying Working…, when the user opens another Bot and comes back", async () => {
    const server = fakeBotServer();
    const { container } = await mount(server);
    await type("hi");
    await settle();
    expect(screen.getAllByText("Working…")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "open Inbox" }));
    await settle();
    expect(screen.getAllByText("Working…")).toHaveLength(1);
    expect(bubbles(container)).toEqual([]);

    // What Ada sent meanwhile is read when the user comes back.
    await server.say("m2", "On it…");
    fireEvent.click(screen.getByRole("button", { name: "open Ada" }));
    await settle();
    await server.say("m3", "Done.");

    expect(bubbles(container)).toEqual([
      ["user", "hi"],
      ["assistant", "On it…"],
      ["assistant", "Done."],
    ]);
    expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

    await server.end("complete");
    // The sidebar row clears once its refetch of `bots.list` answers.
    await waitFor(() => expect(screen.queryByText("Working…")).toBeNull());
    expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
  });
});

describe("statuses from server state, with no send in flight", () => {
  it("shows ••• and Working… for a running Turn", async () => {
    await mount(
      fakeBotServer({
        b2: { messages: [said("m1", "user", "hi")], turnStatus: "running" },
      }),
    );

    expect(await screen.findByRole("status", { name: "Typing" })).toBeTruthy();
    expect(screen.getAllByText("Working…")).toHaveLength(1);
  });

  it("shows Seen ✓ under the last user Message after a complete Turn", async () => {
    await mount(
      fakeBotServer({ b2: { messages: [said("m1", "user", "ok")], turnStatus: "complete" } }),
    );

    expect(await screen.findAllByText("Seen ✓")).toHaveLength(1);
    expect(screen.queryByText("Couldn't reply")).toBeNull();
  });

  it("shows no Seen ✓ when the last Message is the Bot's", async () => {
    await mount(
      fakeBotServer({
        b2: {
          messages: [said("m1", "user", "hi"), said("m2", "assistant", "Hello!")],
          turnStatus: "complete",
        },
      }),
    );

    await screen.findByText("Hello!");
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });

  it("shows Couldn't reply under the last user Message after a failed Turn", async () => {
    await mount(
      fakeBotServer({ b2: { messages: [said("m1", "user", "hi")], turnStatus: "error" } }),
    );

    expect(await screen.findAllByText("Couldn't reply")).toHaveLength(1);
    expect(screen.queryByText("Seen ✓")).toBeNull();
  });
});

describe("the sidebar rows", () => {
  it("shows the time and a preview of the last sent Message, and Working… instead while a Turn runs", async () => {
    const { container } = await mount(
      fakeBotServer({
        b1: { lastMessage: { text: "All caught up", at: new Date("2026-10-17T09:30:00Z") } },
        b2: {
          turnStatus: "running",
          lastMessage: { text: "Earlier reply", at: new Date("2026-10-17T09:10:00Z") },
        },
      }),
    );

    expect(await screen.findByText("All caught up")).toBeTruthy();
    const times = [...container.querySelectorAll("time")];
    expect(times.map((time) => time.getAttribute("datetime"))).toEqual([
      "2026-10-17T09:30:00.000Z",
      "2026-10-17T09:10:00.000Z",
    ]);
    expect(screen.getAllByText("Working…")).toHaveLength(1);
    expect(screen.queryByText("Earlier reply")).toBeNull();
  });
});
