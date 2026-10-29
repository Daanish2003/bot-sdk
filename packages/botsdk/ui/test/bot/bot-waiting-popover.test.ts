// @vitest-environment jsdom
import type { BotReview } from "@botsdk/client/bot/review";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { WaitingPopover } from "../../src/bot/waiting-popover";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { changeLog, hint, settle, stubEventSource } from "./fake-change-log";

beforeEach(stubEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createdAt = new Date("2026-10-29T09:00:00.000Z");
const ada = { id: "b1", name: "Ada", model: "anthropic:claude-sonnet-5-5", createdAt };

const command = `cd /home/user/project && ${"echo ok && ".repeat(30)}rm -rf build`;

const review = (id: string, state: BotReview["state"], input = { command: "git push" }) =>
  ({
    id,
    turnId: "t1",
    helperId: null,
    toolCallId: `call-${id}`,
    tool: "shell",
    input,
    summary: `Summary of ${id}`,
    verdict: "block",
    reason: `Reason for ${id}`,
    state,
    deadline: createdAt,
    expiresAt: new Date("2026-11-05T09:00:00.000Z"),
    decidedAt: null,
    createdAt,
  }) satisfies BotReview;

/** A stand-in for the server: `reviews.list` answers `reviews`, and an answer changes its row. */
function fakeBotServer(reviews: BotReview[]) {
  const log = changeLog();
  const answers: Array<{ answer: string; reviewId: string }> = [];
  const decide = (answer: "allowed" | "denied") =>
    os.input(z.object({ reviewId: z.string() })).handler(({ input }) => {
      answers.push({ answer, reviewId: input.reviewId });
      reviews.find((row) => row.id === input.reviewId)!.state = answer;
      return { decided: true, state: answer };
    });
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
        lastSeq: log.last,
        messages: [],
        turns: [],
        summaries: [],
        warmings: [],
      })),
      stop: os.handler(() => {}),
      warm: os.handler(() => ({ warmed: false as const, skipped: "still_warm" as const })),
    },
    routines: { list: os.handler(() => []) },
    checkIns: { list: os.handler(() => []) },
    helpers: { list: os.handler(() => []) },
    secrets: { list: os.handler(() => []) },
    reviews: {
      list: os.handler(() => reviews.map((row) => ({ ...row }))),
      allow: decide("allowed"),
      deny: decide("denied"),
    },
  };
  const handler = new RPCHandler(router);
  return {
    answers,
    log,
    fetch: async (request: Request) =>
      (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
      new Response(null, { status: 404 }),
  };
}

function mount(server: ReturnType<typeof fakeBotServer>) {
  render(
    providerFor(
      createElement(BotConversation, {
        botId: "b1",
        headerEnd: createElement(WaitingPopover, { botId: "b1" }),
      }),
      { fetch: server.fetch, messages: {} },
    ),
  );
}

describe("the Waiting N popover", { timeout: 30_000 }, () => {
  it("counts the pending Approvals, and lists each as a full card with a link to the rules", async () => {
    mount(
      fakeBotServer([
        review("r1", "pending", { command }),
        review("r2", "pending"),
        review("r3", "allowed"),
        review("r4", "waiting"),
      ]),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Waiting 2" }));
    const cards = await screen.findAllByText(/^Summary of /);
    expect(cards.map((card) => card.textContent)).toEqual(["Summary of r1", "Summary of r2"]);
    const card = cards[0]!.closest("[data-review]")!;
    expect(card.textContent).toContain("Reason for r1");
    expect(card.textContent).toContain("expires");
    const raw = card.querySelector("pre")!;
    expect(raw.textContent).toBe(command);
    expect(raw.className).toContain("whitespace-pre-wrap");
    expect(raw.className).toContain("overflow-y-auto");
    expect(screen.getByText("Rules for all your Bots →")).toBeTruthy();
  });

  it("says nothing waits when there are no pending Approvals", async () => {
    mount(fakeBotServer([review("r3", "allowed")]));

    fireEvent.click(await screen.findByRole("button", { name: "Waiting 0" }));
    expect(await screen.findByText("Nothing is waiting for you")).toBeTruthy();
  });

  it("answers through the reviews router, and an answered item leaves the list", async () => {
    const server = fakeBotServer([review("r1", "pending"), review("r2", "pending")]);
    mount(server);

    fireEvent.click(await screen.findByRole("button", { name: "Waiting 2" }));
    const first = (await screen.findByText("Summary of r1")).closest("[data-review]")!;
    fireEvent.click(within(first as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(server.answers).toEqual([{ answer: "allowed", reviewId: "r1" }]));
    await waitFor(() => expect(screen.queryByText("Summary of r1")).toBeNull());

    const second = screen.getByText("Summary of r2").closest("[data-review]")!;
    fireEvent.click(within(second as HTMLElement).getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(server.answers.at(-1)).toEqual({ answer: "denied", reviewId: "r2" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Waiting 0" })).toBeTruthy());
  });

  it("updates the count when a review changes elsewhere", async () => {
    const reviews = [review("r1", "pending")];
    const server = fakeBotServer(reviews);
    mount(server);
    await screen.findByRole("button", { name: "Waiting 1" });
    await settle();

    reviews.push(review("r2", "pending"));
    server.log.record("review", "r2", reviews[1]!);
    await hint();

    await waitFor(() => expect(screen.getByRole("button", { name: "Waiting 2" })).toBeTruthy(), {
      timeout: 10_000,
    });
  });
});
