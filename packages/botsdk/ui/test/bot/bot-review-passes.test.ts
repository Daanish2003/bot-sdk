// @vitest-environment jsdom
import type { BotReview } from "@botsdk/client/bot/review";
import type { BotMessage, BotTurnProvenance } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const at = (minute: number) => new Date(`2026-10-21T09:${String(minute).padStart(2, "0")}:00.000Z`);
const ada = { id: "b1", name: "Ada", model: "anthropic:claude-sonnet-5-5", createdAt: at(0) };

const said = (id: string, role: BotMessage["role"], text: string, minute: number): BotMessage => ({
  id,
  role,
  text,
  createdAt: at(minute),
});

const turnOf = (id: string, from: number, until: number): BotTurnProvenance => ({
  id,
  status: "complete",
  startedAt: at(from),
  endedAt: at(until),
  sent: true,
  triggers: [{ source: "user", at: at(from) }] as BotTurnProvenance["triggers"],
  memoryChanges: null,
  skillChanges: null,
  knowledgeChanges: null,
  steps: [],
});

const reviewOf = (
  id: string,
  turnId: string,
  verdict: BotReview["verdict"],
  summary: string,
  reason: string,
): BotReview => ({
  id,
  turnId,
  helperId: null,
  toolCallId: `call-${id}`,
  tool: "shell",
  input: { command: "ls" },
  summary,
  verdict,
  reason,
  state: null,
  deadline: null,
  expiresAt: null,
  decidedAt: null,
  createdAt: at(1),
});

/** A stand-in for the server's `bot` router with `turns` and their `reviews`. */
function fakeBotServer(messages: BotMessage[], turns: BotTurnProvenance[], reviews: BotReview[]) {
  const router = {
    bots: {
      get: os.handler(() => ({
        bot: { ...ada, turnStatus: null },
        messages,
        turns,
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
    helpers: { list: os.handler(() => []) },
    reviews: { list: os.handler(() => reviews) },
  };
  const handler = new RPCHandler(router);
  return async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
}

function mount(fetch: (request: Request) => Promise<Response>) {
  return render(
    providerFor(createElement(BotConversation, { botId: "b1" }), { fetch, messages: {} }),
  );
}

describe("the Auto-review passes line", () => {
  it("shows each Turn's passes under its last Bot Message and expands to their summaries and reasons", async () => {
    const messages = [
      said("m1", "user", "list and build", 0),
      said("m2", "assistant", "Done.", 2),
      said("m3", "user", "thanks", 5),
      said("m4", "assistant", "Anytime.", 6),
    ];
    mount(
      fakeBotServer(
        messages,
        [turnOf("t1", 0, 3), turnOf("t2", 5, 7)],
        [
          reviewOf("r1", "t1", "pass", "List the files", "The user asked to list them."),
          reviewOf("r2", "t1", "pass", "Build the app", "The user asked to build it."),
          reviewOf("r3", "t1", "block", "Delete the repo", "Nobody asked for it."),
        ],
      ),
    );

    const line = await screen.findByRole("button", { name: "✓ 2 calls auto-approved" });
    // Under the Turn's last Bot Message, and none for the Turn with no review.
    const done = document.querySelector('[data-id="m2"]');
    expect(done?.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('[data-id="m3"]')?.compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(screen.getAllByRole("button", { name: /auto-approved/ })).toHaveLength(1);
    expect(screen.queryByText("List the files")).toBeNull();

    fireEvent.click(line);

    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("List the files")).toBeTruthy();
    expect(screen.getByText("The user asked to list them.")).toBeTruthy();
    expect(screen.getByText("Build the app")).toBeTruthy();
    expect(screen.getByText("The user asked to build it.")).toBeTruthy();
    // A block isn't a pass.
    expect(screen.queryByText("Delete the repo")).toBeNull();
  });

  it("says call for one pass", async () => {
    mount(
      fakeBotServer(
        [said("m1", "user", "list", 0), said("m2", "assistant", "Done.", 2)],
        [turnOf("t1", 0, 3)],
        [reviewOf("r1", "t1", "pass", "List the files", "The user asked.")],
      ),
    );

    expect(await screen.findByRole("button", { name: "✓ 1 call auto-approved" })).toBeTruthy();
  });
});
