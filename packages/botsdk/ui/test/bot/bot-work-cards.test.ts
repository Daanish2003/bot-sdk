// @vitest-environment jsdom
import type { BotHelper, ComputerCard as ComputerControl } from "@botsdk/client/bot/helper";
import type { DemonstrationCard } from "@botsdk/client/bot/demonstration";
import type { ChoiceControl } from "@botsdk/client/bot/choice";
import type { FilesControl } from "@botsdk/client/bot/files";
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ChoiceCard } from "../../src/bot/choice-card";
import { ComputerCard } from "../../src/bot/computer-card";
import { FilesCard } from "../../src/bot/files-card";
import { HelperCard } from "../../src/bot/helper-card";
import { ShowMeCard } from "../../src/bot/show-me-card";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const noop = async () => {};
const at = new Date("2026-10-21T09:00:00.000Z");

const helper = (status: BotHelper["status"]): BotHelper => ({
  id: "h1",
  type: "general",
  status,
  gist: "Count the files.",
  task: "Count the files in /home/user/shared.",
  report: status === "running" ? null : "There are 3 files.",
  steps: 2,
  latest: status === "running" ? "shell: ls" : null,
  startedAt: at,
  afterMessageId: "m1",
});
const computer = (state: ComputerControl["state"]): ComputerControl => ({
  kind: "computer",
  helperId: "h1",
  reason: "Sign in to Salesforce",
  state,
});
const demonstration = (state: DemonstrationCard["state"]): DemonstrationCard => ({
  kind: "demonstration",
  demonstrationId: "d1",
  goal: "file the report",
  state,
  steps: 3,
  startedAt: at.toISOString(),
  endedAt: null,
});
const files: FilesControl = {
  kind: "files",
  files: [
    {
      id: "6f1c3a52-0b1e-4e9c-9d0a-3c2f5b7a8e10",
      name: "notes.txt",
      size: 12,
      mediaType: "text/plain",
    },
  ],
};
const choice = (answered: boolean): ChoiceControl => ({
  kind: "choice",
  options: ["Red", "Blue"],
  other: true,
  answer: answered ? { text: "Red", other: false } : undefined,
});

const open: Record<string, () => ReactElement> = {
  helper: () =>
    createElement(HelperCard, { helper: helper("running"), onStop: () => {}, stopping: false }),
  computer: () =>
    createElement(ComputerCard, {
      card: computer("open"),
      helper: undefined,
      onDone: () => {},
      acting: false,
    }),
  files: () => createElement(FilesCard, { card: files }),
  choice: () => createElement(ChoiceCard, { card: choice(false), onAnswer: noop, acting: false }),
  showMe: () =>
    createElement(ShowMeCard, {
      card: demonstration("recording"),
      botName: "Ada",
      onAct: () => {},
      acting: false,
    }),
};
const settled: Record<string, () => ReactElement> = {
  computer: () =>
    createElement(ComputerCard, {
      card: computer("done"),
      helper: undefined,
      onDone: () => {},
      acting: false,
    }),
  showMe: () =>
    createElement(ShowMeCard, {
      card: demonstration("saved"),
      botName: "Ada",
      onAct: () => {},
      acting: false,
    }),
  choice: () => createElement(ChoiceCard, { card: choice(true), onAnswer: noop, acting: false }),
};

const mount = (ui: ReactElement) => render(providerFor(ui));
const cardOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-approval-card]");

describe("the work-type cards", () => {
  it.each(Object.keys(open))(
    "%s: the Approval-type card's outlined box at the column's width",
    (kind) => {
      const { container } = mount(open[kind]!());

      const box = cardOf(container)!;
      expect(box).not.toBeNull();
      expect(box.className).toContain("w-full");
      expect(box.className).not.toContain("max-w-");
      expect(box.className).not.toContain("amber");
      expect(box.querySelector("[data-approval-title]")?.textContent).toBeTruthy();
    },
  );

  it.each(Object.keys(settled))("%s: once finished it is a one-line divider", (kind) => {
    const { container } = mount(settled[kind]!());

    expect(cardOf(container)).toBeNull();
    expect(container.querySelector("[data-approval-settled]")).not.toBeNull();
  });

  it.each(["computer", "showMe"])(
    "%s: the live view is not clipped by the body's scroll cap",
    (kind) => {
      const { container } = mount(open[kind]!());

      const body = container.querySelector("[data-approval-body]")!;
      expect(body.querySelector("[data-preview]")).not.toBeNull();
      expect(body.className).toContain("max-h-none");
      expect(body.className).not.toContain("max-h-60");
    },
  );

  it("files: the list is not capped by the body's scroll", () => {
    const { container } = mount(open.files!());

    const body = container.querySelector("[data-approval-body]")!;
    expect(body.querySelector("[data-file]")).not.toBeNull();
    expect(body.className).toContain("max-h-none");
    expect(container.querySelector("[data-approval-actions]")).toBeNull();
  });

  it("choice: the options come before the Other field", () => {
    const { container } = mount(open.choice!());

    const option = container.querySelector("[data-option]")!;
    const field = container.querySelector("input")!;
    expect(option.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("helper: Stop stays outside the scrolling body, and the card name does not change with its status", () => {
    const { container } = mount(open.helper!());

    const stop = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Stop"),
    )!;
    expect(stop.closest("[data-approval-actions]")).not.toBeNull();
    expect(stop.closest("[data-approval-body]")).toBeNull();
    expect(container.querySelector("[data-approval-title]")?.textContent).not.toContain("Working");
  });

  it("show me: the ticking timer is not part of the card's name", () => {
    const { container } = mount(open.showMe!());

    expect(
      container.querySelector("[data-approval-title]")?.querySelector("[data-timer]"),
    ).toBeNull();
    expect(container.querySelector("[data-timer]")?.textContent).toMatch(/^\d+:\d\d$/);
  });
});
