// @vitest-environment jsdom
import type { BotHelper } from "@botsdk/client/bot/helper";
import type { BotChange } from "@botsdk/client/bot/changes";
import type { BotRoutine } from "@botsdk/client/bot/routine";
import type { BotTasks, TaskTrigger } from "@botsdk/client/bot/tasks";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { changeLog, hint, stubEventSource } from "./fake-change-log";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-29T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

const empty = (): BotTasks => ({
  inProgress: { turn: null, helpers: [] },
  scheduled: { triggers: [], routines: [], checkIns: [] },
  done: { helpers: [], checkIns: [], skipped: [] },
});

const helper = (over: Partial<BotHelper> = {}): BotHelper => ({
  id: "h1",
  type: "general",
  task: "Count the files.",
  gist: "Count the files.",
  status: "running",
  steps: 1,
  latest: null,
  report: null,
  startedAt: createdAt,
  afterMessageId: null,
  ...over,
});

const trigger = (over: Partial<TaskTrigger>): TaskTrigger => ({
  id: "x",
  source: "user",
  channel: "web",
  label: null,
  receivedAt: createdAt,
  skippedAt: null,
  skipReason: null,
  ...over,
});

/** A stand-in for the server's `bot` router, whose Tasks view is `tasks` (a test changes it). */
function mount(tasks: BotTasks, log = changeLog()) {
  const state = { tasks, stops: 0, tasksCalls: 0 };
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
      tasks: os.handler(() => {
        state.tasksCalls += 1;
        return state.tasks;
      }),
      stop: os.handler(() => {
        state.stops += 1;
      }),
    },
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    checkIns: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    helpers: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  render(providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }));
  return state;
}

const openTab = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
  if (name !== "In progress") fireEvent.click(await screen.findByRole("tab", { name }));
};

describe("the Tasks popover", () => {
  it("counts the running Turn, the live Helpers and the waiting Triggers", async () => {
    const tasks = empty();
    tasks.inProgress = {
      turn: { id: "t1", startedAt: createdAt },
      helpers: [helper(), helper({ id: "h2", status: "waiting" })],
    };
    tasks.scheduled.triggers = [trigger({ id: "w1" })];
    // Routines and Check-ins that merely repeat are not live work.
    tasks.scheduled.routines = [
      {
        id: "r1",
        name: "morning-brief",
        prompt: "x",
        schedule: { days: ["mon"], at: "08:00" },
        webhook: false,
        timeZone: "Europe/London",
        state: "active",
        approvedAt: createdAt,
        createdAt,
        nextRunAt: null,
      } satisfies BotRoutine,
    ];
    mount(tasks);

    expect(await screen.findByRole("button", { name: /^Tasks 4/ })).toBeTruthy();
  });

  it("shows three tabs, In progress first, with the running Turn's Stop", async () => {
    const tasks = empty();
    tasks.inProgress.turn = { id: "t1", startedAt: createdAt };
    const state = mount(tasks);

    await openTab("In progress");

    const tabs = within(await screen.findByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["In progress", "true"],
      ["Scheduled", "false"],
      ["Done", "false"],
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Stop the running Turn" }));
    await waitFor(() => expect(state.stops).toBe(1));
  });

  it("lists the waiting Triggers under Scheduled, with no skip control yet", async () => {
    const tasks = empty();
    tasks.scheduled.triggers = [
      trigger({ id: "w1", source: "routine", channel: "schedule", label: "morning-brief" }),
      trigger({ id: "w2", source: "routine", channel: "webhook", label: "stripe-payouts" }),
      trigger({ id: "w3", source: "check_in", channel: "schedule", label: "Has Acme replied?" }),
      trigger({ id: "w4", source: "helper", channel: "helper", label: "Count the files." }),
      trigger({ id: "w5" }),
    ];
    mount(tasks);

    await openTab("Scheduled");

    const items = within(await screen.findByRole("list", { name: "Scheduled" })).getAllByRole(
      "listitem",
    );
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Routine morning-brief"),
      expect.stringContaining("Webhook call to stripe-payouts"),
      expect.stringContaining("Check-in: Has Acme replied?"),
      expect.stringContaining("Report from Count the files."),
      expect.stringContaining("Your Message"),
    ]);
  });

  it("shows the skipped runs under Done as skipped, with why", async () => {
    const tasks = empty();
    tasks.done.skipped = [
      trigger({
        id: "s1",
        source: "routine",
        channel: "schedule",
        label: "morning-brief",
        skippedAt: createdAt,
        skipReason: "paused",
      }),
      trigger({
        id: "s2",
        source: "routine",
        channel: "webhook",
        label: "stripe-payouts",
        skippedAt: createdAt,
        skipReason: "cancelled",
      }),
      trigger({
        id: "s3",
        source: "check_in",
        label: "Has Acme replied?",
        skippedAt: createdAt,
        skipReason: "reset",
      }),
    ];
    mount(tasks);

    await openTab("Done");

    const items = within(await screen.findByRole("list", { name: "Done" })).getAllByRole(
      "listitem",
    );
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/Routine morning-brief.*skipped: the Bot was paused/),
      expect.stringMatching(/Webhook call to stripe-payouts.*skipped: you skipped it/),
      expect.stringMatching(/Check-in: Has Acme replied\?.*skipped: the Bot was reset/),
    ]);
  });

  it("says so when a tab is empty", async () => {
    mount(empty());

    await openTab("Done");

    expect(await screen.findByText("Nothing here.")).toBeTruthy();
  });

  it("replaces the To-do and the Routines · Check-ins buttons", async () => {
    const tasks = empty();
    tasks.inProgress.helpers = [helper()];
    mount(tasks);

    await screen.findByRole("button", { name: /^Tasks 1$/ });

    expect(screen.queryByRole("button", { name: /To-do/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Routines/ })).toBeNull();
  });

  it("updates when the change log says a Helper started or a Turn ended", async () => {
    const log = changeLog();
    const state = mount(empty(), log);
    await screen.findByRole("button", { name: /^Tasks 0$/ });

    state.tasks = { ...empty(), inProgress: { turn: null, helpers: [helper()] } };
    log.record("helper", "h1", helper() as Extract<BotChange, { kind: "helper" }>["data"]);
    await hint();
    await screen.findByRole("button", { name: /^Tasks 1$/ });

    state.tasks = empty();
    log.record("turn", "t1", {
      id: "t1",
      status: "complete",
      startedAt: createdAt,
      endedAt: createdAt,
    });
    await hint();
    await screen.findByRole("button", { name: /^Tasks 0$/ });
  });
});
