// @vitest-environment jsdom
import type { BotReview } from "@botsdk/client/bot/review";
import type { BotRoutine } from "@botsdk/client/bot/routine";
import type { CustomRule } from "@botsdk/client/bot/rule";
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewRequest } from "../../src/bot/review-request";
import { RoutineCard } from "../../src/bot/routine-card";
import { RuleCard } from "../../src/bot/rule-card";
import { SecretCard } from "../../src/bot/secret-card";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const at = new Date("2026-10-21T09:00:00.000Z");
const noop = async () => {};

const routine = (state: BotRoutine["state"]): BotRoutine => ({
  id: "ro1",
  name: "morning-brief",
  prompt: "Summarise my inbox.",
  schedule: { days: ["mon"], times: ["08:00"] },
  webhook: false,
  timeZone: "UTC",
  state,
  readOnly: false,
  approvedAt: null,
  createdAt: at,
  nextRunAt: null,
});
const rule = (state: CustomRule["state"]): CustomRule => ({
  id: "ru1",
  text: "Ask before deleting files.",
  mode: "ask",
  state,
  proposedByBotId: "b1",
  createdAt: at,
  updatedAt: at,
});
const review = (state: BotReview["state"], command = "git push origin main"): BotReview => ({
  id: "r1",
  turnId: "t1",
  helperId: null,
  toolCallId: "call-1",
  tool: "shell",
  input: { command },
  summary: "Push to the main branch",
  verdict: "block",
  reason: "You asked to fix the tests, not to push.",
  state,
  deadline: new Date(Date.now() + 15_000),
  expiresAt: null,
  decidedAt: null,
  createdAt: at,
});

const routineCard = (state: BotRoutine["state"]) =>
  createElement(RoutineCard, {
    routine: routine(state),
    webhookToken: undefined,
    onApprove: noop,
    onDecline: noop,
    onPause: noop,
    onResume: noop,
    onDelete: noop,
    actingRoutines: new Set<string>(),
  });
const ruleCard = (state: CustomRule["state"]) =>
  createElement(RuleCard, { rule: rule(state), onApprove: noop, onDeny: noop, acting: false });
const secretCard = (saved: boolean) =>
  createElement(SecretCard, {
    request: { kind: "secret", name: "GITHUB_TOKEN", why: "To push." },
    botName: "Ada",
    saved,
    onSave: noop,
    saving: false,
  });
const reviewCard = (state: BotReview["state"], command?: string) =>
  createElement(ReviewRequest, {
    review: review(state, command),
    onAllow: noop,
    onDeny: noop,
    acting: false,
  });

const open: Record<string, () => ReactElement> = {
  routine: () => routineCard("pending"),
  rule: () => ruleCard("proposed"),
  secret: () => secretCard(false),
  review: () => reviewCard("pending"),
};
const settled: Record<string, () => ReactElement> = {
  routine: () => routineCard("active"),
  rule: () => ruleCard("active"),
  secret: () => secretCard(true),
  review: () => reviewCard("allowed"),
};

const mount = (ui: ReactElement) => render(providerFor(ui));
const cardOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-approval-card]");

describe("the Approval-type cards", () => {
  it.each(Object.keys(open))(
    "%s: an outlined box at the column's width, with title, status and actions",
    (kind) => {
      const { container } = mount(open[kind]!());

      const box = cardOf(container)!;
      expect(box).not.toBeNull();
      expect(box.className).toContain("w-full");
      expect(box.className).not.toContain("max-w-");
      expect(box.className).toContain("border");
      expect(box.querySelector("[data-approval-title]")?.textContent).toBeTruthy();
      expect(box.querySelector("[data-approval-actions] button")).not.toBeNull();
    },
  );

  it.each(Object.keys(settled))("%s: once settled it is a one-line divider", (kind) => {
    const { container } = mount(settled[kind]!());

    expect(cardOf(container)).toBeNull();
    expect(container.querySelector("[data-approval-settled]")).not.toBeNull();
  });

  it.each(["allowed", "denied", "expired"] as const)("a %s Approval is a divider", (state) => {
    const { container } = mount(reviewCard(state));

    expect(container.querySelector("[data-approval-settled]")).not.toBeNull();
    expect(cardOf(container)).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it.each(["waiting", "pending"] as const)(
    "gives an Approval %s on the user an amber border",
    (state) => {
      const { container } = mount(reviewCard(state));

      expect(cardOf(container)!.className).toContain("border-amber");
    },
  );

  it.each(["routine", "rule", "secret"])("gives a %s card no amber border", (kind) => {
    const { container } = mount(open[kind]!());

    expect(cardOf(container)!.className).not.toContain("amber");
  });

  it("keeps the buttons in view on a very long card: only the body scrolls", () => {
    const command = `${"echo ok && ".repeat(400)}git push origin last-branch`;
    const { container } = mount(reviewCard("pending", command));

    const box = cardOf(container)!;
    const body = box.querySelector<HTMLElement>("[data-approval-body]")!;
    expect(body.textContent).toContain("git push origin last-branch");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toMatch(/max-h-/);
    const allow = box.querySelector<HTMLElement>("[data-approval-actions] button")!;
    expect(body.contains(allow)).toBe(false);
    expect(allow.closest("[data-approval-actions]")?.parentElement).toBe(box);
  });

  it("keeps a Secret's value in a masked field", () => {
    const { container } = mount(open.secret!());

    expect(container.querySelector("input")?.getAttribute("type")).toBe("password");
  });
});
