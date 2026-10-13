// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { TurnChange } from "../../../core/shared/memory/changes";
import { MemoryChip } from "../../../ui/chat/memory-changes";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
});

const changes: TurnChange[] = [
  { kind: "added", memoryId: "m1", text: "Is vegetarian" },
  { kind: "updated", memoryId: "m2", from: "Eats meat", text: "Eats fish" },
  { kind: "forgot", text: "Lives in Delhi" },
];

/** The chip, in English, as the reply shows it. */
function renderChip(list: TurnChange[]) {
  return render(providerFor(createElement(MemoryChip, { changes: list }), { messages: {} }));
}

describe("the 'Memory updated' chip", () => {
  it("says how many changes the turn made", () => {
    renderChip(changes);

    expect(screen.getByRole("button", { name: "Memory updated · 3 changes" })).toBeTruthy();
  });

  it("says one change in the singular", () => {
    renderChip([changes[0]!]);

    expect(screen.getByRole("button", { name: "Memory updated · 1 change" })).toBeTruthy();
  });

  it("shows nothing when the turn changed no Memory", () => {
    const { container } = renderChip([]);

    expect(container.innerHTML).toBe("");
  });

  it("opens a popover listing each change, the updated text struck through, and a link to Memory", () => {
    renderChip(changes);

    fireEvent.click(screen.getByRole("button", { name: "Memory updated · 3 changes" }));

    expect(screen.getByText("Added: Is vegetarian")).toBeTruthy();
    expect(screen.getByText("Forgot: Lives in Delhi")).toBeTruthy();
    const updated = screen.getByText(/^Updated:/);
    expect(updated.textContent).toBe("Updated: Eats meat → Eats fish");
    expect(updated.querySelector("s")?.textContent).toBe("Eats meat");
    expect(screen.getByText("Manage Memory")).toBeTruthy();
  });
});
