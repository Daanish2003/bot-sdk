// @vitest-environment jsdom
import type { ReleaseApproval } from "@botsdk/client/bot/release-approval";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseApprovalCard } from "../../src/bot/release-approval-card";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const dayMs = 24 * 60 * 60 * 1000;

const card = (changes: Partial<ReleaseApproval> = {}): ReleaseApproval => ({
  kind: "release_approval",
  representativeId: "rep-1",
  representativeName: "Front desk",
  path: "/representatives/rep-1",
  expiresAt: new Date(Date.now() + dayMs).toISOString(),
  ...changes,
});

const show = (given: ReleaseApproval) =>
  render(
    providerFor(
      createElement(ReleaseApprovalCard, { card: given, text: "Customers ask about hours." }),
    ),
  );

describe("ReleaseApprovalCard", () => {
  it("only links to the Representative's page while it waits: it has no answer buttons", () => {
    const { container } = show(card());

    expect(container.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(screen.getByText("Customers ask about hours.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(container.querySelector("a")).not.toBeNull();
  });

  it("settles to one line once answered, keeping the link", () => {
    const { container } = show(card({ answer: "declined" }));

    expect(container.querySelector('[data-state="declined"]')).not.toBeNull();
    expect(screen.queryByText("Customers ask about hours.")).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();
  });

  it("shows as expired past its 7 days, and still links to the page", () => {
    const { container } = show(card({ expiresAt: new Date(Date.now() - 1).toISOString() }));

    expect(container.querySelector('[data-state="expired"]')).not.toBeNull();
    expect(container.querySelector("a")).not.toBeNull();
  });
});
