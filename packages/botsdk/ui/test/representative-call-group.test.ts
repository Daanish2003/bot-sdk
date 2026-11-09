// @vitest-environment jsdom
import { representativeClient, type ThreadMessageView } from "@botsdk/representative/client";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { providerFor } from "@ai-chat/test-support/fake-dictionary";
import { CallGroup } from "../src/representative/representative-threads";

afterEach(cleanup);

const lost: ThreadMessageView = {
  id: "0195c6a0-0000-7000-8000-000000000010",
  author: "call",
  text: "The call ended without a transcript.",
  channel: "sms",
  externalId: "+15550002",
  verified: false,
  reply: null,
  call: {
    status: "ended_no_transcript",
    startedAt: new Date("2026-11-09T12:00:00Z"),
    endedAt: new Date("2026-11-09T12:15:00Z"),
    lines: [],
    requests: [{ request: "Book a visit", callback: "after 5pm", emergency: false }],
  },
  createdAt: new Date("2026-11-09T12:15:00Z"),
};

describe("a Call with no transcript in the thread", () => {
  it("shows its requests, and no line as the Representative's", () => {
    render(
      providerFor(createElement(CallGroup, { message: lost }), {
        fetch: async () => new Response(null, { status: 404 }),
        features: [representativeClient()],
        messages: {},
      }),
    );

    expect(screen.queryByText("The call ended without a transcript.")).toBeNull();
    expect(document.querySelectorAll("[data-call-line]")).toHaveLength(0);
    expect(screen.getByText("Book a visit")).toBeTruthy();
    expect(screen.getByText("Callback: after 5pm")).toBeTruthy();
  });
});
