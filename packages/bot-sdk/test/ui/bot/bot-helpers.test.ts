// @vitest-environment jsdom
import type { BotHelper, HelperStatus } from "@botsdk/client/bot/helper";
import type { BotRoutine } from "@botsdk/client/bot/routine";
import type { BotMessage } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";
import { changeLog, hint, stubEventSource } from "./fake-change-log";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-19T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };

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

/**
 * A stand-in for the server's `bot` router, with the Helpers (and Routines) a test gives it.
 * `helpers.stop` records its input in `stops` and stops them as the server does.
 */
function mount(
  messages: BotMessage[],
  helpers: BotHelper[],
  {
    routines = [],
    stops = [],
    log = changeLog(),
  }: { routines?: BotRoutine[]; stops?: unknown[]; log?: ReturnType<typeof changeLog> } = {},
) {
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
        messages,
        turns: [],
        lastSeq: log.last,
      })),
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
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => routines) },
    checkIns: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    helpers: {
      list: os.input(z.object({ botId: z.string() })).handler(() => helpers.map((h) => ({ ...h }))),
      stop: os
        .input(z.object({ botId: z.string(), helperId: z.string().optional() }))
        .handler(({ input }) => {
          stops.push(input);
          helpers.forEach((h, index) => {
            const live = h.status === "running" || h.status === "waiting";
            if (live && (!input.helperId || input.helperId === h.id)) {
              helpers[index] = { ...h, status: "stopped", latest: null };
            }
          });
        }),
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

    fireEvent.click(within(card(container)).getByRole("button", { expanded: false }));

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
      fireEvent.click(within(card(container)).getByRole("button", { expanded: false }));
      expect(card(container).textContent?.includes("Report: There are 3 files.")).toBe(!live);
    },
  );

  it("updates the same card in place when the Helper ends, with no finished line", async () => {
    const helpers = [helper("m1")];
    const log = changeLog();
    const { container } = mount([said("m1", "assistant", "On it.")], helpers, { log });
    await screen.findByText("Working");
    const before = card(container);

    helpers[0] = { ...helpers[0]!, status: "complete", latest: null, report: "There are 3 files." };
    log.record("helper", "h1", helpers[0]);
    await hint();

    await waitFor(() => expect(card(container).dataset.status).toBe("complete"));
    expect(card(container)).toBe(before);
    expect(container.querySelectorAll("[data-helper]")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/finished/i);
    expect(card(container).textContent).toContain("Done");
    expect(card(container).textContent).not.toContain("step 2");
  });
});

describe("stopping a Helper from its card (#591)", () => {
  it("offers Stop in the expanded card of a live Helper, which calls the router", async () => {
    const stops: unknown[] = [];
    const { container } = mount([said("m1", "assistant", "On it.")], [helper("m1")], { stops });
    await screen.findByText("Working");

    fireEvent.click(within(card(container)).getByRole("button", { expanded: false }));
    fireEvent.click(within(card(container)).getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(card(container).dataset.status).toBe("stopped"));
    expect(stops).toEqual([{ botId: "b2", helperId: "h1" }]);
    expect(within(card(container)).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("has no Stop once the Helper ended", async () => {
    const { container } = mount(
      [said("m1", "assistant", "On it.")],
      [helper("m1", { status: "complete", report: "3." })],
    );
    await screen.findByText("Done");

    fireEvent.click(within(card(container)).getByRole("button", { expanded: false }));

    expect(within(card(container)).queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("the To-do list (#591)", () => {
  const two = () => [
    helper("m1"),
    helper("m1", {
      id: "h2",
      gist: "Sign in to Salesforce.",
      type: "computer_use",
      status: "waiting",
    }),
    helper("m1", { id: "h3", gist: "Old task.", status: "complete", report: "Done." }),
  ];

  it("counts the running and waiting Helpers, with a dot when one needs the user", async () => {
    mount([said("m1", "assistant", "On it.")], two());

    const button = await screen.findByRole("button", { name: /To-do 2/ });
    expect(button.querySelector("[data-needs-you]")).not.toBeNull();
  });

  it("has no dot when no Helper needs the user, and no button when none is live", async () => {
    mount([said("m1", "assistant", "On it.")], [helper("m1")]);
    const button = await screen.findByRole("button", { name: /To-do 1/ });
    expect(button.querySelector("[data-needs-you]")).toBeNull();
    cleanup();

    mount([said("m1", "assistant", "On it.")], [helper("m1", { status: "complete" })]);
    await screen.findByText("Done");
    expect(screen.queryByRole("button", { name: /To-do/ })).toBeNull();
  });

  it("lists each live Helper with its status and a stop ×, and Stop all when there are several", async () => {
    const stops: unknown[] = [];
    mount([said("m1", "assistant", "On it.")], two(), { stops });

    fireEvent.click(await screen.findByRole("button", { name: /To-do 2/ }));
    const list = await screen.findByRole("list", { name: "To-do" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Count the files in /home/user/shared."),
      expect.stringContaining("Sign in to Salesforce."),
    ]);
    expect(items[0]!.textContent).toContain("Working");
    expect(items[1]!.textContent).toContain("Needs you");

    fireEvent.click(within(list).getByRole("button", { name: "Stop Sign in to Salesforce." }));
    await waitFor(() => expect(stops).toEqual([{ botId: "b2", helperId: "h2" }]));
    await screen.findByRole("button", { name: /To-do 1/ });
    // One left: no Stop all.
    expect(screen.queryByRole("button", { name: "Stop all Helpers" })).toBeNull();
  });

  it("stops every Helper with Stop all Helpers", async () => {
    const stops: unknown[] = [];
    mount([said("m1", "assistant", "On it.")], two(), { stops });

    fireEvent.click(await screen.findByRole("button", { name: /To-do 2/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop all Helpers" }));

    await waitFor(() => expect(stops).toEqual([{ botId: "b2" }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /To-do/ })).toBeNull());
  });
});

describe("a Helper a background run started (#591)", () => {
  it("shows while the page is open and idle, with no reload", async () => {
    const routine: BotRoutine = {
      id: "r1",
      name: "morning-brief",
      prompt: "Summarize today's calendar.",
      schedule: { days: ["mon"], at: "08:00" },
      webhook: false,
      timeZone: "Europe/London",
      state: "active",
      approvedAt: createdAt,
      createdAt,
      nextRunAt: null,
    };
    const helpers: BotHelper[] = [];
    const log = changeLog();
    mount([said("m1", "assistant", "On it.")], helpers, { routines: [routine], log });
    await screen.findByText("On it.");

    // A Routine's Turn starts a Helper on the server; this page sends nothing.
    helpers.push(helper("m1"));
    log.record("helper", "h1", helpers[0]!);
    await hint();

    await screen.findByText("Count the files in /home/user/shared.");
  });
});
