// @vitest-environment jsdom
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { backgroundPollMs } from "../../../plugins/bot/client/react/bot-turn";
import type { BotRoutine } from "../../../plugins/bot/shared/routine";
import type { BotMessage, BotSendEvent, BotTurnProvenance } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
  webhook: false,
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
  const paused: string[] = [];
  const resumed: string[] = [];
  const deleted: string[] = [];
  const rotated: string[] = [];
  const setState = (routineId: string, state: BotRoutine["state"]) => {
    const routine = routines.find((row) => row.id === routineId)!;
    routine.state = state;
    return { id: routine.id, state };
  };
  let turnStatus: "running" | "complete" | null = null;
  // While set, pause, resume and delete answer only once it resolves.
  let held: Promise<void> | undefined;
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
          return {
            id: routine.id,
            state: routine.state,
            approvedAt: routine.approvedAt,
            ...(routine.webhook && { webhookToken: "approved-token" }),
          };
        }),
        decline: os.input(z.object({ routineId: z.string() })).handler(({ input }) => {
          declined.push(input.routineId);
          routines.splice(
            routines.findIndex((row) => row.id === input.routineId),
            1,
          );
        }),
        pause: os.input(z.object({ routineId: z.string() })).handler(async ({ input }) => {
          await held;
          paused.push(input.routineId);
          return setState(input.routineId, "paused");
        }),
        resume: os.input(z.object({ routineId: z.string() })).handler(({ input }) => {
          resumed.push(input.routineId);
          return setState(input.routineId, "active");
        }),
        delete: os.input(z.object({ routineId: z.string() })).handler(async ({ input }) => {
          await held;
          deleted.push(input.routineId);
          routines.splice(
            routines.findIndex((row) => row.id === input.routineId),
            1,
          );
        }),
        rotate: os.input(z.object({ routineId: z.string() })).handler(({ input }) => {
          rotated.push(input.routineId);
          return { webhookToken: `rotated-token-${rotated.length}` };
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
    paused,
    resumed,
    deleted,
    rotated,
    routines,
    /** What `bot.get` says of the latest Turn from now on, as a Turn run elsewhere moves on. */
    setTurnStatus: (status: "running" | "complete" | null) => {
      turnStatus = status;
    },
    /** Holds every pause and delete answer until the returned release is called. */
    holdActions: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
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
    memoryChanges: null,
    skillChanges: null,
    knowledgeChanges: null,
    steps: [],
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
    memoryChanges: null,
    skillChanges: null,
    knowledgeChanges: null,
    steps: [],
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

  it("shows a run that happened while the page was open and idle, with no reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const messages = [...before];
      const turns = [userTurn];
      const server = fakeBotServer(
        messages,
        [{ ...morningBrief("m1"), state: "active", approvedAt: createdAt }],
        turns,
      );
      const { container } = mount(server);
      await screen.findByText("Morning to you.");
      expect(screen.queryByText(/next run/)).toBeNull();

      // The Routine runs on the server; this page sends nothing.
      messages.push(sentAt("m3", "assistant", "Three meetings today.", "2026-10-19T07:00:02.000Z"));
      turns.push(run(true));
      // A run too quick to be seen running still moves the Routine on to its next slot.
      server.routines[0]!.nextRunAt = new Date("2026-10-20T07:00:00.000Z");
      await act(() => vi.advanceTimersByTimeAsync(backgroundPollMs));

      await screen.findByText("Three meetings today.");
      expect(timeline(container)[2]).toMatch(/^run:morning-brief · /);
      await screen.findByText(/morning-brief approved · next run/);
    } finally {
      vi.useRealTimers();
    }
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

describe("the Routines popover in the header", () => {
  const routines = (): BotRoutine[] => [
    { ...morningBrief("m1"), state: "active", approvedAt: createdAt },
    {
      ...morningBrief("m1"),
      id: "r2",
      name: "weekly-review",
      schedule: { days: ["fri"], at: "16:00" },
      state: "paused",
      approvedAt: createdAt,
    },
    { ...morningBrief("m1"), id: "r3", name: "inbox-sweep" },
  ];

  /** Opens the popover and returns its list of Routines. */
  const open = async (count: number) => {
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^Routines ${count}`) }));
    return screen.findByRole("list", { name: "Routines" });
  };
  const row = (list: HTMLElement, name: string) =>
    within(list)
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes(name))!;

  it("counts the approved Routines and lists every Routine with its schedule and state", async () => {
    const server = fakeBotServer([said("m1", "user", "Brief me")], routines());
    mount(server);

    const list = await open(2);

    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^morning-brief.*weekdays 08:00.*active/),
      expect.stringMatching(/^weekly-review.*fri 16:00.*paused/),
      expect.stringMatching(/^inbox-sweep.*weekdays 08:00.*waiting for OK/),
    ]);
    // A pending Routine is approved or declined on its card, not here.
    expect(within(row(list, "inbox-sweep")).queryAllByRole("button")).toEqual([]);
  });

  it("pauses, resumes and deletes through the router", async () => {
    const server = fakeBotServer([said("m1", "user", "Brief me")], routines());
    mount(server);
    const list = await open(2);

    fireEvent.click(
      within(row(list, "morning-brief")).getByRole("button", { name: "Pause morning-brief" }),
    );
    await waitFor(() => expect(server.paused).toEqual(["r1"]));
    fireEvent.click(
      within(row(list, "weekly-review")).getByRole("button", { name: "Resume weekly-review" }),
    );
    await waitFor(() => expect(server.resumed).toEqual(["r2"]));
    fireEvent.click(
      within(row(list, "weekly-review")).getByRole("button", { name: "Delete weekly-review" }),
    );
    await waitFor(() => expect(server.deleted).toEqual(["r2"]));

    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        expect.stringMatching(/^morning-brief.*paused/),
        expect.stringMatching(/^inbox-sweep/),
      ]),
    );
  });

  it("keeps a Routine's actions busy in the popover while its divider's action runs, so only one is sent", async () => {
    const server = fakeBotServer(
      [said("m1", "user", "Brief me")],
      [{ ...morningBrief("m1"), state: "active", approvedAt: createdAt }],
    );
    const { container } = mount(server);
    await screen.findByText(/morning-brief approved/);
    const release = server.holdActions();

    const divider = container.querySelector<HTMLElement>("[data-routine=morning-brief]")!;
    fireEvent.click(within(divider).getByRole("button", { name: "Pause morning-brief" }));
    const list = await open(1);
    const remove = within(row(list, "morning-brief")).getByRole<HTMLButtonElement>("button", {
      name: "Delete morning-brief",
    });
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    release();

    await screen.findByText("morning-brief paused");
    expect(server.paused).toEqual(["r1"]);
    expect(server.deleted).toEqual([]);
  });
});

describe("the approved divider", () => {
  it("pauses, resumes and deletes its Routine through the router", async () => {
    const server = fakeBotServer(
      [said("m1", "user", "Brief me")],
      [{ ...morningBrief("m1"), state: "active", approvedAt: createdAt }],
    );
    const { container } = mount(server);
    await screen.findByText(/morning-brief approved/);
    const divider = () => container.querySelector<HTMLElement>("[data-routine=morning-brief]")!;

    fireEvent.click(within(divider()).getByRole("button", { name: "Pause morning-brief" }));
    await screen.findByText("morning-brief paused");
    expect(server.paused).toEqual(["r1"]);
    fireEvent.click(within(divider()).getByRole("button", { name: "Resume morning-brief" }));
    await screen.findByText(/morning-brief approved/);
    expect(server.resumed).toEqual(["r1"]);
    fireEvent.click(within(divider()).getByRole("button", { name: "Delete morning-brief" }));

    await waitFor(() => expect(divider()).toBeNull());
    expect(server.deleted).toEqual(["r1"]);
  });
});

describe("a webhook Routine", () => {
  const payouts = (state: BotRoutine["state"], id = "r4", name = "stripe-payouts"): BotRoutine => ({
    ...morningBrief("m1"),
    id,
    name,
    prompt: "Check the payout.",
    schedule: null,
    webhook: true,
    state,
    approvedAt: state === "pending" ? null : createdAt,
  });
  const urlOf = (token: string) => `${window.location.origin}/api/routines/webhook/${token}`;

  const open = async (count: number) => {
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^Routines ${count}`) }));
    return screen.findByRole("list", { name: "Routines" });
  };
  const row = (list: HTMLElement, name: string) =>
    within(list)
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes(name))!;

  it("shows 'on webhook' on its approval card", async () => {
    mount(fakeBotServer([said("m1", "user", "Watch my payouts")], [payouts("pending")]));

    const card = await screen.findByRole("group", { name: "Created stripe-payouts routine" });
    expect(card.textContent).toContain("on webhook");
    expect(card.textContent).not.toContain("weekdays");
  });

  it("shows the URL with Copy and Rotate only on an approved webhook Routine's popover row", async () => {
    const server = fakeBotServer(
      [said("m1", "user", "Watch my payouts")],
      [
        { ...morningBrief("m1"), state: "active", approvedAt: createdAt },
        payouts("pending", "r5", "github-issues"),
        payouts("active"),
      ],
    );
    mount(server);

    const list = await open(2);

    expect(within(row(list, "stripe-payouts")).getByText(/on webhook/)).toBeTruthy();
    expect(
      within(row(list, "stripe-payouts")).getByRole("button", { name: "Rotate" }),
    ).toBeTruthy();
    expect(within(row(list, "morning-brief")).queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(within(row(list, "morning-brief")).queryByText(/routines.webhook/)).toBeNull();
    expect(within(row(list, "github-issues")).queryAllByRole("button")).toEqual([]);
    expect(within(row(list, "github-issues")).queryByText(/routines.webhook/)).toBeNull();
  });

  it("rotates through the router, then shows the new URL to copy", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const server = fakeBotServer([said("m1", "user", "Watch my payouts")], [payouts("active")]);
    mount(server);
    const list = await open(1);
    // Only its hash is stored, so the URL shows once: after approving, or after a rotate.
    expect(within(row(list, "stripe-payouts")).queryByRole("button", { name: "Copy" })).toBeNull();

    fireEvent.click(within(row(list, "stripe-payouts")).getByRole("button", { name: "Rotate" }));

    await waitFor(() => expect(server.rotated).toEqual(["r4"]));
    const url = await within(row(list, "stripe-payouts")).findByText(urlOf("rotated-token-1"));
    expect(url.className).toContain("font-mono");
    fireEvent.click(within(row(list, "stripe-payouts")).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(urlOf("rotated-token-1")));
  });

  it("shows the URL approving it gave, under its approved divider and in the popover", async () => {
    const server = fakeBotServer([said("m1", "user", "Watch my payouts")], [payouts("pending")]);
    mount(server);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(/stripe-payouts approved/);
    expect(await screen.findByText(urlOf("approved-token"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    const list = await open(1);

    expect(within(row(list, "stripe-payouts")).getByText(urlOf("approved-token"))).toBeTruthy();
  });

  it("gives its run a divider with a webhook icon", async () => {
    const at = new Date("2026-10-19T10:42:00.000Z");
    const server = fakeBotServer(
      [
        {
          ...said("m2", "assistant", "That payout looks off."),
          createdAt: new Date(at.getTime() + 2000),
        },
      ],
      [],
      [
        {
          id: "t2",
          status: "complete",
          startedAt: new Date(at.getTime() + 1000),
          endedAt: new Date(at.getTime() + 5000),
          sent: true,
          memoryChanges: null,
          skillChanges: null,
          knowledgeChanges: null,
          steps: [],
          triggers: [{ source: "routine", channel: "webhook", routineName: "stripe-payouts", at }],
        },
      ],
    );
    const { container } = mount(server);

    await screen.findByText("That payout looks off.");
    const divider = container.querySelector<HTMLElement>("[data-run=stripe-payouts]")!;
    expect(divider.querySelector(".lucide-webhook")).not.toBeNull();
    expect(divider.querySelector(".lucide-clock")).toBeNull();
  });
});
