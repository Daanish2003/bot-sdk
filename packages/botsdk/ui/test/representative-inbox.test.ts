// @vitest-environment jsdom
import { type InboxHeldView, representativeClient } from "@botsdk/representative/client";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { InboxPage } from "../src/representative/inbox-page";

afterEach(cleanup);

const heldOn = (rule: string): InboxHeldView =>
  ({
    id: "0195c6a0-0000-7000-8000-000000000001",
    text: "A held reply",
    rule,
    channel: "fake",
    externalId: "+15550001",
    threadId: "0195c6a0-0000-7000-8000-000000000002",
    representativeId: "0195c6a0-0000-7000-8000-000000000003",
    representativeName: "Front desk",
    customerName: "Grace",
    createdAt: new Date("2026-10-22T09:00:00Z"),
  }) as InboxHeldView;

function showing(
  held: InboxHeldView[],
  truncated = { held: false, drafts: false, running: false },
) {
  const handler = new RPCHandler({
    representative: {
      inbox: os.handler(() => ({ held, running: [], truncated })),
      replyDraftList: os.handler(() => []),
      list: os.handler(() => []),
    },
    pages: { list: os.handler(() => []) },
  });
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  render(
    providerFor(createElement(InboxPage), {
      fetch,
      features: [representativeClient()],
      messages: {},
    }),
  );
}

describe("a held message in the owner's inbox", () => {
  it.each([
    ["caps", "your limits on how much it may send"],
    ["quietHours", "quiet hours"],
    ["channel", "the Channel's limits"],
    ["topicAtRelease", "its topic"],
  ])("says what holds it in words, for the rule %s", async (rule, words) => {
    showing([heldOn(rule)]);

    fireEvent.click(await screen.findByRole("button", { name: /Grace/ }));

    const said = await screen.findByText(new RegExp(words));
    expect(said.textContent).not.toContain(rule);
  });
});

describe("the owner's inbox lists", () => {
  it("says nothing when it shows them all", async () => {
    showing([heldOn("caps")]);

    await screen.findByRole("button", { name: /Grace/ });

    expect(screen.queryByText(/more than this list shows/)).toBeNull();
    expect(screen.queryByText(/most recently active/)).toBeNull();
  });

  it("says when the queue can't show all that waits", async () => {
    showing([heldOn("caps")], { held: true, drafts: false, running: false });

    expect(await screen.findByText(/more than this list shows/)).toBeTruthy();
  });

  it("says so when it is the drafts", async () => {
    showing([heldOn("caps")], { held: false, drafts: true, running: false });

    expect(await screen.findByText(/more than this list shows/)).toBeTruthy();
  });

  it("says when it can't show every running thread", async () => {
    showing([], { held: false, drafts: false, running: true });

    expect(await screen.findByText(/most recently active/)).toBeTruthy();
  });
});
