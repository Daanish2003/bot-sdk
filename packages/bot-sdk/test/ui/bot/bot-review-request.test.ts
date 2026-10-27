// @vitest-environment jsdom
import type { BotHelper } from "@botsdk/client/bot/helper";
import type { BotReview } from "@botsdk/client/bot/review";
import type { BotMessage, BotTurnProvenance } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const at = (minute: number, second = 0) =>
  new Date(
    `2026-10-21T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`,
  );
const ada = { id: "b1", name: "Ada", model: "anthropic:claude-sonnet-5-5", createdAt: at(0) };

const said = (id: string, role: BotMessage["role"], text: string, minute: number): BotMessage => ({
  id,
  role,
  text,
  createdAt: at(minute),
});

const turn: BotTurnProvenance = {
  id: "t1",
  status: "running",
  startedAt: at(0),
  endedAt: null,
  sent: true,
  triggers: [{ source: "user", at: at(0) }] as BotTurnProvenance["triggers"],
  memoryChanges: null,
  skillChanges: null,
  knowledgeChanges: null,
  steps: [],
};

/** A block of Turn t1's `git push` at 09:02, asked at `askedAt`, standing as `state`. */
const blockOf = (state: BotReview["state"], askedAt = at(2)): BotReview => ({
  id: "r1",
  turnId: "t1",
  helperId: null,
  toolCallId: "call-1",
  tool: "shell",
  input: { command: "git push origin main" },
  summary: "Push to the main branch",
  verdict: "block",
  reason: "You asked to fix the tests, not to push to main.",
  state,
  deadline: new Date(askedAt.getTime() + 15_000),
  decidedAt: state === "waiting" ? null : askedAt,
  createdAt: askedAt,
});

/** The Message that asks the user about review `r1`, written when the call was blocked. */
const asked: BotMessage = {
  ...said("a1", "assistant", "Push to the main branch", 2),
  control: { kind: "review_approval", reviewId: "r1" },
};

const messages = [
  said("m1", "user", "fix the tests", 0),
  said("m2", "assistant", "On it.", 1),
  asked,
  said("m3", "assistant", "Done.", 3),
];

/** A General Helper that Turn t1 started after m2, still working. */
const helper: BotHelper = {
  id: "h1",
  type: "general",
  task: "Run the tests.",
  gist: "Run the tests.",
  status: "running",
  steps: 1,
  latest: "shell: make deploy",
  report: null,
  startedAt: at(1),
  afterMessageId: "m2",
};

/**
 * A stand-in for the server's `bot` router whose one review is `review()`, and whose Helpers are
 * `helpers`, with its answers.
 */
function fakeBotServer(review: () => BotReview, helpers: BotHelper[] = []) {
  const answers: Array<{ answer: string; reviewId: string }> = [];
  const decide = (answer: "allowed" | "denied") =>
    os.input(z.object({ reviewId: z.string() })).handler(({ input }) => {
      answers.push({ answer, reviewId: input.reviewId });
      return { decided: true, state: answer };
    });
  const router = {
    bots: {
      get: os.handler(() => ({
        bot: { ...ada, turnStatus: null },
        messages,
        turns: [turn],
        summaries: [],
        warmings: [],
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
      warm: os.handler(() => ({ warmed: false as const, skipped: "still_warm" as const })),
    },
    routines: { list: os.handler(() => []) },
    checkIns: { list: os.handler(() => []) },
    helpers: { list: os.handler(() => helpers) },
    reviews: {
      list: os.handler(() => [review()]),
      allow: decide("allowed"),
      deny: decide("denied"),
    },
  };
  const handler = new RPCHandler(router);
  return {
    answers,
    fetch: async (request: Request) =>
      (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
      new Response(null, { status: 404 }),
  };
}

function mount(fetch: (request: Request) => Promise<Response>) {
  return render(
    providerFor(createElement(BotConversation, { botId: "b1" }), { fetch, messages: {} }),
  );
}

describe("the Approval request card", () => {
  it("shows the summary, reason and command at the call's place, and counts down for 15 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(2, 5) });
    const server = fakeBotServer(() => blockOf("waiting"));
    mount(server.fetch);

    const card = (await screen.findByText("Push to the main branch")).closest("[data-review]")!;
    expect(card.textContent).toContain("You asked to fix the tests, not to push to main.");
    expect(card.querySelector("code")?.textContent).toBe("git push origin main");
    expect(card.textContent).toContain("Blocked in 10s unless you allow it");
    expect(card.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("10");
    // In the thread: after the Message before the call, and before the one after it. The Message
    // itself draws only the card, not a bubble of its own.
    expect(document.querySelector('[data-id="a1"]')).toBeNull();
    const before = document.querySelector('[data-id="m2"]')!;
    const after = document.querySelector('[data-id="m3"]')!;
    expect(before.compareDocumentPosition(card)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after.compareDocumentPosition(card)).toBe(Node.DOCUMENT_POSITION_PRECEDING);

    // The bar drains.
    act(() => vi.setSystemTime(at(2, 11)));
    await waitFor(() => expect(card.textContent).toContain("Blocked in 4s unless you allow it"));
  });

  it("shows a long command whole, wrapped and scrollable, so its end is read before Allow", async () => {
    const command = `cd /home/user/project && make test && ${"echo ok && ".repeat(30)}git push origin main --force`;
    const server = fakeBotServer(() => ({ ...blockOf("waiting", new Date()), input: { command } }));
    mount(server.fetch);

    const card = (await screen.findByText("Push to the main branch")).closest("[data-review]")!;
    const shown = card.querySelector("pre")!;
    expect(shown.textContent).toBe(command);
    expect(shown.className).toContain("whitespace-pre-wrap");
    expect(shown.className).toContain("overflow-y-auto");
    expect(shown.className).not.toContain("truncate");
  });

  it("sends Allow and Deny for the request", async () => {
    const server = fakeBotServer(() => blockOf("waiting", new Date()));
    mount(server.fetch);

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(server.answers).toEqual([{ answer: "allowed", reviewId: "r1" }]));
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(server.answers).toEqual([
        { answer: "allowed", reviewId: "r1" },
        { answer: "denied", reviewId: "r1" },
      ]),
    );
  });

  it("closes into a divider once no answer came in 15 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(2, 14) });
    const server = fakeBotServer(() => blockOf("waiting"));
    mount(server.fetch);
    await screen.findByText("Push to the main branch");

    act(() => vi.setSystemTime(at(2, 16)));

    expect(
      await screen.findByText("Blocked, no answer in 15 s: Push to the main branch"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("shows a Helper's request in the thread like a Turn's, not under the Helper's line", async () => {
    const helperBlock = (state: BotReview["state"]): BotReview => ({
      ...blockOf(state, new Date()),
      turnId: null,
      helperId: "h1",
      input: { command: "make deploy" },
      summary: "Deploy",
    });
    const waiting = fakeBotServer(() => helperBlock("waiting"), [helper]);
    const { unmount } = mount(waiting.fetch);

    const card = (await screen.findByText("Deploy")).closest("[data-review]")!;
    expect(card.closest('[data-helper="h1"]')).toBeNull();
    expect(card.querySelector("code")?.textContent).toBe("make deploy");
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(waiting.answers).toEqual([{ answer: "allowed", reviewId: "r1" }]));
    unmount();

    mount(fakeBotServer(() => helperBlock("allowed"), [helper]).fetch);
    const divider = (await screen.findByText("Allowed by you: Deploy")).closest("[data-review]")!;
    expect(divider.closest('[data-helper="h1"]')).toBeNull();
  });

  it.each([
    ["allowed", "Allowed by you: Push to the main branch"],
    ["denied", "Denied by you: Push to the main branch"],
    ["expired", "Blocked, no answer in 15 s: Push to the main branch"],
  ] as const)("closes an %s request into its divider", async (state, divider) => {
    const server = fakeBotServer(() => blockOf(state));
    mount(server.fetch);

    expect(await screen.findByText(divider)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText("git push origin main")).toBeNull();
  });
});
