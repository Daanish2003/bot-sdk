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
  output: null,
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

describe("the Never-allowed divider", () => {
  it("shows a one-line divider for a never review, under its Turn's last Bot Message", async () => {
    mount(
      fakeBotServer(
        [said("m1", "user", "move my money", 0), said("m2", "assistant", "Over to you.", 2)],
        [turnOf("t1", 0, 3)],
        [reviewOf("r1", "t1", "never", "Transfer $5,000", "moving money between accounts")],
      ),
    );

    const divider = await screen.findByText("Never allowed · Transfer $5,000");

    const line = divider.closest("[data-never-allowed]");
    expect(line?.getAttribute("title")).toBe("moving money between accounts");
    expect(line?.className).toContain("text-red-500");
    expect(document.querySelector('[data-id="m2"]')?.compareDocumentPosition(line!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // It is not a pass, and offers no Approval.
    expect(screen.queryByRole("button", { name: /auto-approved/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});

describe("the activity rows", () => {
  it("opens under the Turn line with each pass's summary, command and output, under its last Bot Message", async () => {
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
          {
            ...reviewOf("r1", "t1", "pass", "List the files", "The user asked to list them."),
            output: "a.txt\nb.txt",
          },
          reviewOf("r2", "t1", "pass", "Build the app", "The user asked to build it."),
          reviewOf("r3", "t1", "block", "Delete the repo", "Nobody asked for it."),
        ],
      ),
    );

    const line = await screen.findByRole("button", { name: "Activity" });
    const done = document.querySelector('[data-id="m2"]');
    expect(done?.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('[data-id="m3"]')?.compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(screen.getAllByRole("button", { name: "Activity" })).toHaveLength(1);
    expect(screen.queryByText("List the files")).toBeNull();

    fireEvent.click(line);

    expect(line.getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getByRole("list", { name: "Activity" }).querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("List the files");
    expect(rows[0]?.textContent).toContain("The user asked to list them.");
    expect(rows[0]?.textContent).toContain("ls");
    expect(rows[0]?.textContent).toContain("a.txt");
    // A call with no output shows its command only.
    expect(rows[1]?.textContent).toContain("Build the app");
    expect(rows[1]?.textContent).not.toContain("Output");
    // A block isn't a pass.
    expect(screen.queryByText("Delete the repo")).toBeNull();
  });

  it("collapses a long output behind a button that works by keyboard", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    mount(
      fakeBotServer(
        [said("m1", "user", "list", 0), said("m2", "assistant", "Done.", 2)],
        [turnOf("t1", 0, 3)],
        [{ ...reviewOf("r1", "t1", "pass", "List the files", "The user asked."), output: long }],
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Activity" }));

    const more = screen.getByRole("button", { name: "Show all 40 lines" });
    expect(more.tagName).toBe("BUTTON");
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a Never-allowed call red and visible with the panel closed", async () => {
    mount(
      fakeBotServer(
        [said("m1", "user", "go", 0), said("m2", "assistant", "No.", 2)],
        [turnOf("t1", 0, 3)],
        [
          reviewOf("r1", "t1", "never", "Transfer $5,000", "moving money"),
          reviewOf("r2", "t1", "pass", "List the files", "ok"),
        ],
      ),
    );

    const never = await screen.findByText("Never allowed · Transfer $5,000");
    expect(never.closest("[data-never-allowed]")?.className).toContain("text-red-500");
    expect(screen.queryByText("List the files")).toBeNull();
  });
});
