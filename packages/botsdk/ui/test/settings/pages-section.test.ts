// @vitest-environment jsdom
import { pageIdInput, type PageRow } from "@botsdk/client/bot/pages";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { PagesSection } from "../../src/settings/pages-section";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const stalled: PageRow = {
  id: "0195c6a0-0000-7000-8000-000000000001",
  cause: "assignment_overdue",
  urgency: "routine",
  title: "An Assignment stalled",
  text: "Your Bot has not finished the refund for Grace.",
  path: "/representatives/one",
  createdAt: new Date("2026-10-30T09:00:00.000Z"),
};

/** A stand-in for the server's `pages` procedures, recording what is acknowledged. */
function fakePagesServer(initial: PageRow[], truncated = false) {
  let pages = initial;
  const acknowledged: string[] = [];
  const handler = new RPCHandler({
    pages: {
      list: os.handler(() => ({ pages, truncated })),
      acknowledge: os.input(pageIdInput).handler(({ input }) => {
        acknowledged.push(input.id);
        pages = pages.filter((page) => page.id !== input.id);
      }),
    },
  });
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, acknowledged };
}

function show(server: ReturnType<typeof fakePagesServer>) {
  return render(providerFor(createElement(PagesSection), { fetch: server.fetch, messages: {} }));
}

describe("PagesSection", () => {
  it("lists a Page, and acknowledging it takes it away", async () => {
    const server = fakePagesServer([stalled]);
    const { container } = show(server);

    const list = await screen.findByRole("list", { name: "Pages" });
    expect(within(list).getByText(stalled.title)).toBeTruthy();
    expect(within(list).getByText(stalled.text)).toBeTruthy();
    expect(within(list).getByRole("link", { name: stalled.title }).getAttribute("href")).toBe(
      stalled.path,
    );
    fireEvent.click(within(list).getByRole("button", { name: `Acknowledge ${stalled.title}` }));

    await waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(server.acknowledged).toEqual([stalled.id]);
  });

  it("shows a Page's Markdown as plain text", async () => {
    show(fakePagesServer([{ ...stalled, text: "**Refund** for Grace" }]));

    expect(await screen.findByText("Refund for Grace")).toBeTruthy();
  });

  it("marks an emergency", async () => {
    show(fakePagesServer([{ ...stalled, urgency: "emergency" }]));

    expect(await screen.findByText("Emergency")).toBeTruthy();
  });

  it("says the list is cut off only when it is", async () => {
    show(fakePagesServer([stalled], true));
    expect(await screen.findByText(/more Pages than this list shows/)).toBeTruthy();
    cleanup();

    show(fakePagesServer([stalled], false));
    await screen.findByText(stalled.title);
    expect(screen.queryByText(/more Pages than this list shows/)).toBeNull();
  });

  it("renders nothing with no Page waiting", async () => {
    const server = fakePagesServer([]);
    const { container } = show(server);

    await waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(screen.queryByText("Pages")).toBeNull();
  });
});
