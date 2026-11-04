// @vitest-environment jsdom
import type { FactApproval } from "@botsdk/client/bot/fact-approval";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FactApprovalCard } from "../../src/bot/fact-approval-card";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const card = (changes: Partial<FactApproval> = {}): FactApproval => ({
  kind: "fact_approval",
  key: "price.haircut",
  path: "/facts",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...changes,
});

const show = (given: FactApproval) =>
  render(providerFor(createElement(FactApprovalCard, { card: given, text: "The price changed." })));

describe("FactApprovalCard", () => {
  it("only links to the Facts page while it waits: it has no answer buttons", () => {
    const { container } = show(card());

    expect(container.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(screen.getByText("The price changed.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(container.querySelector("a")).not.toBeNull();
  });

  it("settles to one line once answered, keeping the link", () => {
    const { container } = show(card({ answer: "approved" }));

    expect(container.querySelector('[data-state="approved"]')).not.toBeNull();
    expect(screen.queryByText("The price changed.")).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();
  });

  it("shows as expired past its 7 days", () => {
    const { container } = show(card({ expiresAt: new Date(Date.now() - 1).toISOString() }));

    expect(container.querySelector('[data-state="expired"]')).not.toBeNull();
  });
});
