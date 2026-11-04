// @vitest-environment jsdom
import { representativeClient, type RepresentativeView } from "@botsdk/representative/client";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { RepresentativePage } from "../src/representative/representative-page";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const id = "0195c6a0-0000-7000-8000-000000000001";

/** A stand-in for the server's `representative` procedures, keeping the caps it is given. */
function fakeServer() {
  let caps = { maxInARow: 5, maxPerDay: 20 };
  const saved: unknown[] = [];
  const view = () =>
    ({
      id,
      name: "Front desk",
      botId: null,
      enabled: false,
      liveReleaseNumber: null,
      caps,
      draft: { tools: [], skills: [], documents: [], tests: [] },
      approval: null,
      liveRelease: null,
      releases: [],
      testStatus: "none",
      tests: [],
    }) as unknown as RepresentativeView;
  const handler = new RPCHandler({
    representative: {
      get: os.handler(view),
      threadList: os.handler(() => []),
      diff: os.handler(() => ({ liveReleaseNumber: null, changes: [] })),
      setCaps: os
        .input(z.object({ id: z.string(), maxInARow: z.number(), maxPerDay: z.number() }))
        .handler(({ input }) => {
          saved.push(input);
          caps = { ...caps, ...input };
          return view();
        }),
    },
    bots: { list: os.handler(() => []) },
  });
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, saved };
}

describe("the caps form on the Representative page", () => {
  it("shows the caps, and saving sends what the owner typed", async () => {
    const server = fakeServer();
    render(
      providerFor(createElement(RepresentativePage, { id }), {
        fetch: server.fetch,
        features: [representativeClient()],
        messages: {},
      }),
    );

    const inARow = (await screen.findByLabelText("In a row with no reply")) as HTMLInputElement;
    const perDay = screen.getByLabelText("Per Customer per day") as HTMLInputElement;
    expect([inARow.value, perDay.value]).toEqual(["5", "20"]);
    fireEvent.change(inARow, { target: { value: "3" } });
    fireEvent.change(perDay, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save caps" }));

    await waitFor(() => expect(server.saved).toEqual([{ id, maxInARow: 3, maxPerDay: 12 }]));
  });
});
