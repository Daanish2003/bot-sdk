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
  let spendingCaps = {
    threadCalls: 30,
    threadMicros: 500_000,
    customerCalls: 60,
    customerMicros: 2_000_000,
    strangerCalls: 20,
    strangerMicros: 500_000,
    monthMicros: 50_000_000,
  };
  const saved: unknown[] = [];
  const savedDrafts: Record<string, unknown>[] = [];
  const savedSpending: unknown[] = [];
  const savedQuietHours: unknown[] = [];
  let quietHours = { startHour: 21, endHour: 8, timeZone: "UTC" };
  const view = () =>
    ({
      id,
      name: "Front desk",
      botId: null,
      enabled: false,
      liveReleaseNumber: null,
      caps,
      spendingCaps,
      monthUsedPercent: 0,
      quietHours,
      draft: {
        tools: [],
        skills: [],
        documents: [],
        tests: [],
        emergencyText: "Call 112.",
        emergencyKeywords: ["fire"],
      },
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
      updateDraft: os
        .input(z.object({ id: z.string(), draft: z.record(z.string(), z.unknown()) }))
        .handler(({ input }) => {
          savedDrafts.push(input.draft);
          return view();
        }),
      setSpendingCaps: os
        .input(z.object({ id: z.string() }).catchall(z.number()))
        .handler(({ input }) => {
          savedSpending.push(input);
          spendingCaps = { ...spendingCaps, ...input };
          return view();
        }),
      setCaps: os
        .input(z.object({ id: z.string(), maxInARow: z.number(), maxPerDay: z.number() }))
        .handler(({ input }) => {
          saved.push(input);
          caps = { ...caps, ...input };
          return view();
        }),
      setQuietHours: os
        .input(
          z.object({
            id: z.string(),
            startHour: z.number(),
            endHour: z.number(),
            timeZone: z.string(),
          }),
        )
        .handler(({ input }) => {
          savedQuietHours.push(input);
          const { id: _, ...hours } = input;
          quietHours = hours;
          return view();
        }),
    },
    bots: { list: os.handler(() => []) },
  });
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, saved, savedDrafts, savedSpending, savedQuietHours };
}

describe("the emergency script on the Representative page's draft", () => {
  it("shows its text and keywords, and saving sends what the owner typed, a keyword to a line", async () => {
    const server = fakeServer();
    render(
      providerFor(createElement(RepresentativePage, { id }), {
        fetch: server.fetch,
        features: [representativeClient()],
        messages: {},
      }),
    );

    const text = (await screen.findByLabelText("Emergency message")) as HTMLTextAreaElement;
    const keywords = screen.getByLabelText("Emergency keywords") as HTMLTextAreaElement;
    expect([text.value, keywords.value]).toEqual(["Call 112.", "fire"]);
    fireEvent.change(text, { target: { value: "Dial 999." } });
    fireEvent.change(keywords, { target: { value: "fire\n gas leak \n\n" } });
    expect(keywords.value).toBe("fire\n gas leak \n\n");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(server.savedDrafts).toMatchObject([
        { emergencyText: "Dial 999.", emergencyKeywords: ["fire", "gas leak"] },
      ]),
    );
  });
});

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

  it("shows the spending caps in dollars, and saving sends them in micros", async () => {
    const server = fakeServer();
    render(
      providerFor(createElement(RepresentativePage, { id }), {
        fetch: server.fetch,
        features: [representativeClient()],
        messages: {},
      }),
    );

    const perThread = (await screen.findByLabelText("Dollars per thread")) as HTMLInputElement;
    const monthly = screen.getByLabelText("Dollars per month, all Customers") as HTMLInputElement;
    const calls = screen.getByLabelText("Model calls per thread") as HTMLInputElement;
    expect([perThread.value, monthly.value, calls.value]).toEqual(["0.5", "50", "30"]);
    fireEvent.change(perThread, { target: { value: "0.75" } });
    fireEvent.change(calls, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save spending caps" }));

    await waitFor(() =>
      expect(server.savedSpending).toEqual([
        {
          id,
          threadCalls: 12,
          threadMicros: 750_000,
          customerCalls: 60,
          customerMicros: 2_000_000,
          strangerCalls: 20,
          strangerMicros: 500_000,
          monthMicros: 50_000_000,
        },
      ]),
    );
  });
});

describe("the quiet hours form on the Representative page", () => {
  it("shows the hours and the business time zone, and saving sends what the owner typed", async () => {
    const server = fakeServer();
    render(
      providerFor(createElement(RepresentativePage, { id }), {
        fetch: server.fetch,
        features: [representativeClient()],
        messages: {},
      }),
    );

    const start = (await screen.findByLabelText("From hour (0 to 23)")) as HTMLInputElement;
    const end = screen.getByLabelText("Until hour (0 to 23)") as HTMLInputElement;
    const zone = screen.getByLabelText("Business time zone") as HTMLInputElement;
    expect([start.value, end.value, zone.value]).toEqual(["21", "8", "UTC"]);
    fireEvent.change(start, { target: { value: "22" } });
    fireEvent.change(end, { target: { value: "7" } });
    fireEvent.change(zone, { target: { value: "Europe/Paris" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));

    await waitFor(() =>
      expect(server.savedQuietHours).toEqual([
        { id, startHour: 22, endHour: 7, timeZone: "Europe/Paris" },
      ]),
    );
  });
});
