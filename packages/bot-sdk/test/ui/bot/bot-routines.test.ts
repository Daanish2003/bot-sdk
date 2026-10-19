// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BotRoutine } from "../../../plugins/bot/shared/routine";
import type { BotMessage, BotSendEvent, BotTurnProvenance } from "../../../plugins/bot/shared/turn";
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

const morningBrief = (afterMessageId: string): BotRoutine => ({
  id: "r1",
  name: "morning-brief",
  prompt: "Summarize today's calendar.",
  schedule: { days: ["mon", "tue", "wed", "thu", "fri"], at: "08:00" },
  timeZone: "Europe/London",
  state: "pending",
  approvedAt: null,
  createdAt,
  afterMessageId,
  nextRunAt: null,
});

/**
 * A stand-in for the server's `bot` router: `bot.get` answers with `messages` and `turns`, `bot.routine.list`
 * with `routines`, approve and decline change them as the server does, and each `bot.send` streams
 * the events the test pushes.
 */
function fakeBotServer(
  messages: BotMessage[],
  routines: BotRoutine[] = [],
  turns: BotTurnProvenance[] = [],
) {
  const queue: (BotSendEvent | "end")[] = [];
  let wake = () => {};
  const approved: string[] = [];
  const declined: string[] = [];
  let turnStatus: "running" | "complete" | null = null;
  const router = {
    bot: {
      get: os.handler(() => ({
        bot: { ...ada, turnStatus },
        messages: [...messages],
        turns: [...turns],
      })),
      stop: os.handler(() => {}),
      send: os
        .input(z.object({ botId: z.string(), id: z.string(), text: z.string() }).loose())
        .output(eventIterator(z.custom<BotSendEvent>()))
        .handler(async function* () {
          while (true) {
            if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            const next = queue.shift()!;
            if (next === "end") return;
            if (next.type === "message") messages.push(next.message);
            yield next;
          }
        }),
      routine: {
        list: os.input(z.object({ botId: z.string() })).handler(() => [...routines]),
        approve: os.input(z.object({ routineId: z.string() })).handler(({ input }) => {
          approved.push(input.routineId);
          const routine = routines.find((row) => row.id === input.routineId)!;
          routine.state = "active";
          routine.approvedAt = createdAt;
          return { id: routine.id, state: routine.state, approvedAt: routine.approvedAt };
        }),
        decline: os.input(z.object({ routineId: z.string() })).handler(({ input }) => {
          declined.push(input.routineId);
          routines.splice(
            routines.findIndex((row) => row.id === input.routineId),
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
    approved,
    declined,
    routines,
    /** What `bot.get` says of the latest Turn from now on, as a Turn run elsewhere moves on. */
    setTurnStatus: (status: "running" | "complete" | null) => {
      turnStatus = status;
    },
    /** Streams `events` to the open send, then lets the client read them. */
    stream: async (...events: (BotSendEvent | "end")[]) => {
      await act(async () => {
        queue.push(...events);
        wake();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
  };
}

function mount(server: ReturnType<typeof fakeBotServer>) {
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), {
      fetch: server.fetch,
      messages: {},
    }),
  );
}

/** The Conversation's rows in order: each Message's text, each Routine card's or divider's text. */
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-routine]")].map((row) =>
    row.dataset.routine ? `${row.dataset.routine}:${row.dataset.state}` : row.textContent,
  );

describe("a Routine waiting for the user's OK", () => {
  it("shows its approval card right after the Turn that created it, with its schedule, zone and prompt", async () => {
    const server = fakeBotServer(
      [
        said("m1", "user", "Brief me every weekday at 8"),
        said("m2", "assistant", "Set up morning-brief. Approve it below."),
        said("m3", "user", "Thanks"),
      ],
      [morningBrief("m2")],
    );
    const { container } = mount(server);

    const card = await screen.findByRole("group", { name: "Created morning-brief routine" });
    expect(rows(container)).toEqual([
      "Brief me every weekday at 8",
      "Set up morning-brief. Approve it below.",
      "morning-brief:pending",
      "Thanks",
    ]);
    expect(card.textContent).toContain("weekdays 08:00");
    expect(card.textContent).toContain("Europe/London");
    expect(card.textContent).toContain("Summarize today's calendar.");
  });

  it("approves through the router, then collapses to the approved divider", async () => {
    const server = fakeBotServer([said("m1", "user", "Brief me")], [morningBrief("m1")]);
    mount(server);
    const card = await screen.findByRole("group", { name: "Created morning-brief routine" });

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));

    await screen.findByText("morning-brief approved");
    expect(server.approved).toEqual(["r1"]);
    expect(screen.queryByRole("group", { name: "Created morning-brief routine" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("declines through the router, and the card goes", async () => {
    const server = fakeBotServer([said("m1", "user", "Brief me")], [morningBrief("m1")]);
    mount(server);
    const card = await screen.findByRole("group", { name: "Created morning-brief routine" });

    fireEvent.click(within(card).getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Created morning-brief routine" })).toBeNull(),
    );
    expect(server.declined).toEqual(["r1"]);
  });

  it("appears once the Turn that created it ends", async () => {
    const server = fakeBotServer([]);
    mount(server);
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Brief me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await server.stream({ type: "message", message: said("m1", "user", "Brief me") });

    server.routines.push(morningBrief("m1"));
    await server.stream({ type: "turnEnded", status: "complete" }, "end");

    await screen.findByRole("group", { name: "Created morning-brief routine" });
  });

  it("appears once a Turn run elsewhere, which created it, ends", async () => {
    const server = fakeBotServer([said("m1", "user", "Brief me")]);
    server.setTurnStatus("running");
    mount(server);
    await screen.findByRole("status", { name: "Typing" });

    server.routines.push(morningBrief("m1"));
    server.setTurnStatus("complete");

    await screen.findByRole("group", { name: "Created morning-brief routine" }, { timeout: 5_000 });
  });
});

describe("a Routine's runs", () => {
  const at = (iso: string) => new Date(iso);
  const sentAt = (id: string, role: BotMessage["role"], text: string, iso: string) => ({
    ...said(id, role, text),
    createdAt: at(iso),
  });
  const run = (sent: boolean): BotTurnProvenance => ({
    id: "t2",
    status: "complete",
    startedAt: at("2026-10-19T07:00:01.000Z"),
    endedAt: at("2026-10-19T07:00:05.000Z"),
    sent,
    triggers: [
      {
        source: "routine",
        channel: "schedule",
        routineName: "morning-brief",
        at: at("2026-10-19T07:00:00.000Z"),
      },
    ],
  });
  const userTurn: BotTurnProvenance = {
    id: "t1",
    status: "complete",
    startedAt: at("2026-10-19T06:00:01.000Z"),
    endedAt: at("2026-10-19T06:00:05.000Z"),
    sent: true,
    triggers: [
      { source: "user", channel: "web", routineName: null, at: at("2026-10-19T06:00:00.000Z") },
    ],
  };
  const before = [
    sentAt("m1", "user", "Morning!", "2026-10-19T06:00:00.000Z"),
    sentAt("m2", "assistant", "Morning to you.", "2026-10-19T06:00:02.000Z"),
  ];

  /** The Conversation's rows in order: each Message's text, and each run divider's. */
  const timeline = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>("[data-bot-message], [data-run]")].map((row) =>
      row.dataset.run ? `run:${row.textContent}` : row.textContent,
    );

  it("puts a divider with the Routine's name and time above the Messages its run sent, and never collapses them", async () => {
    const server = fakeBotServer(
      [
        ...before,
        sentAt("m3", "assistant", "Three meetings today.", "2026-10-19T07:00:02.000Z"),
        sentAt("m4", "assistant", "The first is at 9.", "2026-10-19T07:00:03.000Z"),
      ],
      [],
      [userTurn, run(true)],
    );
    const { container } = mount(server);

    await screen.findByText("Three meetings today.");
    const rows = timeline(container);
    expect(rows.slice(0, 2)).toEqual(["Morning!", "Morning to you."]);
    expect(rows[2]).toMatch(/^run:morning-brief · \S.*$/);
    expect(rows[2]).not.toContain("nothing to say");
    expect(rows.slice(3)).toEqual(["Three meetings today.", "The first is at 9."]);
  });

  it("gives a quiet run a divider of its own", async () => {
    const server = fakeBotServer(
      [...before, sentAt("m3", "user", "Anything new?", "2026-10-19T08:00:00.000Z")],
      [],
      [userTurn, run(false)],
    );
    const { container } = mount(server);

    await screen.findByText("Anything new?");
    const rows = timeline(container);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatch(/^run:morning-brief · .+ · ran, nothing to say$/);
    expect(rows[3]).toBe("Anything new?");
  });
});

describe("an approved Routine", () => {
  it("shows its next run on its divider", async () => {
    const server = fakeBotServer(
      [said("m1", "user", "Brief me")],
      [
        {
          ...morningBrief("m1"),
          state: "active",
          approvedAt: createdAt,
          nextRunAt: new Date("2026-10-20T07:00:00.000Z"),
        },
      ],
    );
    mount(server);

    expect((await screen.findByText(/morning-brief approved/)).textContent).toMatch(
      /^morning-brief approved · next run \S.*$/,
    );
  });
});
