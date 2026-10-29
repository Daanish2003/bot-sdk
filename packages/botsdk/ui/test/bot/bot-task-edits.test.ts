// @vitest-environment jsdom
import type { BotCheckIn } from "@botsdk/client/bot/check-in";
import type { BotRoutine } from "@botsdk/client/bot/routine";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { changeLog, stubEventSource } from "./fake-change-log";
import { tasksOf } from "./fake-tasks";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-29T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

const routine = (over: Partial<BotRoutine> = {}): BotRoutine => ({
  id: "r1",
  name: "morning-brief",
  prompt: "Summarize today's calendar.",
  schedule: { days: ["mon", "tue", "wed", "thu", "fri"], at: "08:00" },
  webhook: false,
  readOnly: false,
  timeZone: "Europe/London",
  state: "active",
  approvedAt: createdAt,
  createdAt,
  nextRunAt: null,
  ...over,
});

const checkIn = (over: Partial<BotCheckIn> = {}): BotCheckIn => ({
  id: "c1",
  at: new Date("2026-10-30T09:30:00.000Z"),
  note: "Has Acme replied?",
  state: "pending",
  createdAt,
  afterMessageId: null,
  ...over,
});

/** A stand-in server holding `routines` and `checkIns`; its edit calls are recorded, or refused. */
function mount({
  routines = [],
  checkIns = [],
  refuse,
}: {
  routines?: BotRoutine[];
  checkIns?: BotCheckIn[];
  refuse?: string;
}) {
  const log = changeLog();
  const state = { routineEdits: [] as unknown[], checkInEdits: [] as unknown[] };
  const refusal = () => {
    if (refuse) throw new ORPCError("CONFLICT", { data: { code: refuse } });
  };
  const router = {
    conversations: {
      changes: os
        .input(z.object({ conversationId: z.string(), since: z.number() }))
        .handler(({ input }) => log.since(input.since)),
    },
    bots: {
      get: os.handler(() => ({
        bot: { ...ada, turnStatus: null },
        conversationId: "c1",
        messages: [],
        turns: [],
        lastSeq: log.last,
      })),
      tasks: os.handler(() => tasksOf({ routines, checkIns })),
    },
    routines: {
      list: os.input(z.object({ botId: z.string() })).handler(() => routines),
      edit: os.input(z.any()).handler(({ input }) => {
        refusal();
        state.routineEdits.push(input);
        return { id: "r1", state: "active" };
      }),
    },
    checkIns: {
      list: os.input(z.object({ botId: z.string() })).handler(() => checkIns),
      edit: os.input(z.any()).handler(({ input }) => {
        refusal();
        state.checkInEdits.push(input);
      }),
    },
    helpers: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  render(
    createElement(
      Fragment,
      null,
      providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }),
      // The refusal shows as a toast, in the Toaster the page mounts once.
      createElement(Toaster),
    ),
  );
  return state;
}

const openScheduled = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
  fireEvent.click(await screen.findByRole("tab", { name: "Scheduled" }));
};

const openRoutineForm = async () => {
  await openScheduled();
  fireEvent.click(await screen.findByRole("button", { name: "Edit morning-brief" }));
  return screen.findByRole("form", { name: "Edit routine morning-brief" });
};

const openCheckInForm = async () => {
  await openScheduled();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Check-in" }));
  return screen.findByRole("form", { name: "Edit Check-in" });
};

describe("the inline Routine edit form", () => {
  it("edits the prompt and the schedule, sends what changed, and closes", async () => {
    const state = mount({ routines: [routine()] });

    const form = await openRoutineForm();
    fireEvent.change(within(form).getByLabelText("Prompt"), {
      target: { value: "Summarize my inbox." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Fri" }));
    fireEvent.change(within(form).getByLabelText("Time"), { target: { value: "09:15" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.routineEdits).toEqual([
        {
          routineId: "r1",
          prompt: "Summarize my inbox.",
          schedule: { days: ["mon", "tue", "wed", "thu"], at: "09:15" },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  });

  it("sends only the prompt when only it changed", async () => {
    const state = mount({ routines: [routine()] });

    const form = await openRoutineForm();
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "New." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(state.routineEdits).toEqual([{ routineId: "r1", prompt: "New." }]));
  });

  it("shows a read-only Routine as read-only, and the form turns it off", async () => {
    const state = mount({ routines: [routine({ readOnly: true })] });

    await openScheduled();
    const routines = await screen.findByRole("list", { name: "Routines" });
    expect(within(routines).getByText("Read-only")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Edit morning-brief" }));
    const form = await screen.findByRole("form", { name: "Edit routine morning-brief" });
    const toggle = within(form).getByRole("button", { name: "Read-only" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(state.routineEdits).toEqual([{ routineId: "r1", readOnly: false }]));
  });

  it("makes a Routine read-only, with no Read-only shown before", async () => {
    const state = mount({ routines: [routine()] });

    const form = await openRoutineForm();
    expect(
      within(screen.getByRole("list", { name: "Routines" })).queryByText("Read-only", {
        selector: "span",
      }),
    ).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Read-only" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(state.routineEdits).toEqual([{ routineId: "r1", readOnly: true }]));
  });

  it("offers a webhook Routine its prompt only", async () => {
    mount({ routines: [routine({ webhook: true, schedule: null })] });

    const form = await openRoutineForm();

    expect(within(form).getByLabelText("Prompt")).toBeTruthy();
    expect(within(form).queryByLabelText("Time")).toBeNull();
    expect(within(form).queryByRole("button", { name: "Mon" })).toBeNull();
  });

  it("will not save an empty prompt, and Cancel closes without sending", async () => {
    const state = mount({ routines: [routine()] });

    const form = await openRoutineForm();
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "  " } });
    expect(within(form).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(state.routineEdits).toEqual([]);
  });

  it("keeps the form open and says why when the server refuses", async () => {
    const state = mount({ routines: [routine()], refuse: "error.routineNotFound" });

    const form = await openRoutineForm();
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "New." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Routine not found")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Edit routine morning-brief" })).toBeTruthy();
    expect(state.routineEdits).toEqual([]);
  });
});

describe("the inline Check-in edit form", () => {
  const local = (at: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    return `${date}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  };

  it("moves the time and changes the note, sending both", async () => {
    const state = mount({ checkIns: [checkIn()] });

    const form = await openCheckInForm();
    expect((within(form).getByLabelText("When") as HTMLInputElement).value).toBe(
      local(checkIn().at),
    );
    fireEvent.change(within(form).getByLabelText("When"), {
      target: { value: "2026-10-31T10:00" },
    });
    fireEvent.change(within(form).getByLabelText("Note"), { target: { value: "Ping Acme." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.checkInEdits).toEqual([
        { checkInId: "c1", at: new Date("2026-10-31T10:00"), note: "Ping Acme." },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  });

  it("sends only the note when only it changed", async () => {
    const state = mount({ checkIns: [checkIn()] });

    const form = await openCheckInForm();
    fireEvent.change(within(form).getByLabelText("Note"), { target: { value: "Ping Acme." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.checkInEdits).toEqual([{ checkInId: "c1", note: "Ping Acme." }]),
    );
  });

  it("says why when the Check-in already fired, and keeps the form", async () => {
    mount({ checkIns: [checkIn()], refuse: "error.checkInNotPending" });

    const form = await openCheckInForm();
    fireEvent.change(within(form).getByLabelText("Note"), { target: { value: "Late." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/already fired or ended/)).toBeTruthy();
    expect(screen.getByRole("form", { name: "Edit Check-in" })).toBeTruthy();
  });
});
