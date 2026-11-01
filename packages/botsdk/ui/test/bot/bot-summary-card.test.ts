// @vitest-environment jsdom
import type { BotSummary } from "@botsdk/client/bot/turn";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SummaryCard } from "../../src/bot/summary-card";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const show = (summary: BotSummary) =>
  render(providerFor(createElement(SummaryCard, { summary }), { messages: {} }));

/** 14:10 in the test's own time zone, as the card shows it. */
const at = new Date(2026, 9, 21, 14, 10);

const kept = (id: string, text: string, hour: number) => ({
  id,
  role: "assistant" as const,
  text,
  createdAt: new Date(2026, 9, 21, hour, 5),
});

const away: BotSummary = {
  id: "summary-1",
  kind: "away",
  at,
  text: "The user is planning a trip to Lisbon in May.",
  kept: [kept("m1", "Flights are booked.", 12), kept("m2", "Hotel shortlist is ready.", 13)],
};

describe("SummaryCard", () => {
  it("shows when the Bot summarized while the user was away, and expands to the text and the kept Messages", () => {
    show(away);

    const card = screen.getByRole("button", { name: "Summarized while you were away · 14:10" });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(away.text)).toBeNull();
    fireEvent.click(card);

    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(away.text)).toBeTruthy();
    expect(screen.getByText("Kept word for word:")).toBeTruthy();
    expect(screen.getByText("Flights are booked.")).toBeTruthy();
    expect(screen.getByText("Hotel shortlist is ready.")).toBeTruthy();
    expect(screen.getByText("Wed 12:05")).toBeTruthy();
  });

  it("names a mid-Turn Summary as such", () => {
    show({ ...away, kind: "mid_turn", kept: [] });

    fireEvent.click(screen.getByRole("button", { name: "Summarized mid-Turn · 14:10" }));

    expect(screen.getByText(away.text)).toBeTruthy();
    expect(screen.queryByText("Kept word for word:")).toBeNull();
  });

  it("renders Markdown in the Summary and in its kept Messages", () => {
    show({
      ...away,
      text: "## Plan\n\n- **Lisbon** in May",
      kept: [kept("m1", "Booked **flights**", 12)],
    });
    fireEvent.click(screen.getByRole("button", { name: /Summarized/ }));

    const card = document.querySelector<HTMLElement>("[data-summary]")!;
    expect(card.querySelector("h2")?.textContent).toBe("Plan");
    expect(card.querySelectorAll("strong")).toHaveLength(2);
    expect(card.textContent).not.toContain("**");
  });

  it("keeps the safety rules in the Summary and in its kept Messages", () => {
    const risky =
      "[go](javascript:alert(1)) ![pixel](https://attacker.example/a.png) <script>x()</script>";
    show({ ...away, text: risky, kept: [kept("m1", risky, 12)] });
    fireEvent.click(screen.getByRole("button", { name: /Summarized/ }));

    const card = document.querySelector<HTMLElement>("[data-summary]")!;
    expect(card.querySelector("a")).toBeNull();
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("script")).toBeNull();
    expect(card.textContent).toContain("pixel");
  });
});
