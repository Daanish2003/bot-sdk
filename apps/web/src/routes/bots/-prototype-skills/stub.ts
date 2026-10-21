// PROTOTYPE (#711): in-memory stub for the Demonstration and Skills UI. Nothing touches the server.
import { useCallback, useEffect, useRef, useState } from "react";

export type Skill = {
  name: string;
  description: string;
  body: string;
  /** Set when the frontmatter is invalid: the pointer list shows it as "not usable". */
  problem?: string;
  savedBy: "Planner" | "you" | "a Demonstration";
  updatedAt: string;
};

export type DemoEvent = { at: string; kind: string; text: string; masked?: boolean };

export type DemoStatus = "recording" | "paused" | "drafting" | "saved" | "cancelled";

export type Demonstration = {
  goal: string;
  inputs: string[];
  status: DemoStatus;
  events: DemoEvent[];
  startedAt: string;
  skillName?: string;
};

export type Item =
  | { kind: "user"; text: string }
  | { kind: "bot"; text: string }
  | { kind: "trigger"; at: string; text: string }
  | { kind: "demo" }
  | { kind: "skill-saved"; name: string; verb: "saved" | "updated" };

const draftName = "stripe-payouts-to-sheet";

const draftBody = `---
name: ${draftName}
description: Use this when the user wants last week's Stripe payouts copied into the Finance sheet.
---

## Inputs
- **week**: the week to copy (default: last week, Monday to Sunday)

## Steps
1. Open https://dashboard.stripe.com/payouts. If asked to sign in, ask the user to take control.
2. Filter **Date** to the week, then **Export → CSV** (columns: default).
3. Open the "Finance 2026" sheet, tab **Payouts**.
4. **File → Import → Upload** the CSV, choosing **Append to current sheet**.
5. Sort the tab by **Arrival date**, newest first.

## Check the result
- The tab's last rows have arrival dates inside the week, and the row count matches the CSV.
`;

const seedSkills: Skill[] = [
  {
    name: "linkedin-sourcing",
    description: "Use this when the user asks for candidates for a role from LinkedIn.",
    body: "---\nname: linkedin-sourcing\ndescription: Use this when the user asks for candidates for a role from LinkedIn.\n---\n\n## Steps\n1. Search people with the role title and city…\n",
    savedBy: "a Demonstration",
    updatedAt: "Oct 14",
  },
  {
    name: "weekly-metrics",
    description: "Use this when it's Monday and the weekly metrics email is due.",
    body: "---\nname: weekly-metrics\ndescription: Use this when it's Monday and the weekly metrics email is due.\n---\n\n## Steps\n1. Pull signups and revenue from the dashboard…\n",
    savedBy: "Planner",
    updatedAt: "Oct 19",
  },
  {
    name: "expense-report",
    description: "Use this when the user forwards receipts to file as expenses.",
    body: "---\nname: expense-report\ndescription: Use this when the user forwards receipts to file as expenses.\n---\n\n## Steps\n1. Save each receipt to reports/YYYY-MM/…\n",
    savedBy: "you",
    updatedAt: "Oct 20",
  },
  {
    name: "notes-cleanup",
    description: "",
    body: "---\nname: notes-cleanup\n---\n\nTidy notes.md every Friday.\n",
    problem: "no description",
    savedBy: "Planner",
    updatedAt: "Oct 21",
  },
];

const script: Omit<DemoEvent, "at">[] = [
  { kind: "navigate", text: "dashboard.stripe.com/payouts" },
  { kind: "click", text: "“Date” filter" },
  { kind: "select", text: "“Last week”" },
  { kind: "click", text: "“Export”" },
  { kind: "click", text: "“CSV”" },
  { kind: "navigate", text: "docs.google.com/spreadsheets · Finance 2026" },
  { kind: "click", text: "tab “Payouts”" },
  { kind: "click", text: "File › Import" },
  { kind: "input", text: "“Search Drive” = payouts.csv" },
  { kind: "click", text: "“Append to current sheet”" },
  { kind: "input", text: "“Password” = ••••••••", masked: true },
  { kind: "click", text: "column “Arrival date” › Sort Z→A" },
];

const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const startItems: Item[] = [
  { kind: "trigger", at: "09:12", text: "You" },
  {
    kind: "user",
    text: "Let me show you how I copy last week's Stripe payouts into the Finance sheet.",
  },
  {
    kind: "bot",
    text: "Sure. Is it always last week, or do you pick the week? Anything else that changes each time?",
  },
  { kind: "user", text: "Always last week, Monday to Sunday. Nothing else changes." },
];

export function useSkillsStub() {
  const [items, setItems] = useState<Item[]>(startItems);
  const [demo, setDemo] = useState<Demonstration | null>(null);
  const [skills, setSkills] = useState<Skill[]>(seedSkills);
  const [elapsed, setElapsed] = useState(0);
  const step = useRef(0);

  useEffect(() => {
    if (demo?.status !== "recording") return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [demo?.status]);

  const start = useCallback(() => {
    step.current = 0;
    setElapsed(0);
    setDemo({
      goal: "Copy last week's Stripe payouts into the Finance sheet",
      inputs: ["week (last week, Monday to Sunday)"],
      status: "recording",
      events: [],
      startedAt: "09:14",
    });
    setItems((prev) => [
      ...prev.filter((item) => item.kind !== "demo"),
      {
        kind: "bot",
        text: "Opening a Screen for you. Do it once as you normally would, then press Done.",
      },
      { kind: "demo" },
    ]);
  }, []);

  const act = useCallback(() => {
    setDemo((d) => {
      if (!d || d.status !== "recording") return d;
      const next = script[step.current % script.length]!;
      step.current += 1;
      return { ...d, events: [...d.events, { ...next, at: time(elapsed) }] };
    });
  }, [elapsed]);

  const pause = useCallback(
    () =>
      setDemo((d) =>
        d && (d.status === "recording" || d.status === "paused")
          ? { ...d, status: d.status === "recording" ? "paused" : "recording" }
          : d,
      ),
    [],
  );

  const cancel = useCallback(() => {
    setDemo((d) => (d ? { ...d, status: "cancelled" } : d));
    setItems((prev) => [
      ...prev,
      { kind: "bot", text: "Cancelled. I didn't keep anything from that." },
    ]);
  }, []);

  const done = useCallback(() => {
    setDemo((d) => (d ? { ...d, status: "drafting" } : d));
    setTimeout(() => {
      setDemo((d) => (d ? { ...d, status: "saved", skillName: draftName } : d));
      setSkills((prev) => [
        ...prev.filter((s) => s.name !== draftName),
        {
          name: draftName,
          description:
            "Use this when the user wants last week's Stripe payouts copied into the Finance sheet.",
          body: draftBody,
          savedBy: "a Demonstration",
          updatedAt: "just now",
        },
      ]);
      setItems((prev) => [
        ...prev,
        { kind: "skill-saved", name: draftName, verb: "saved" },
        {
          kind: "bot",
          text: "Got it. I saved this as a Skill: open Stripe payouts, filter to last week, export CSV, append it to Finance 2026 › Payouts, sort by arrival date. I skipped what you did while paused. Anything to change? For example, should I message you if a week has no payouts?",
        },
      ]);
    }, 2500);
  }, []);

  const update = useCallback(
    (name: string, body: string) =>
      setSkills((prev) =>
        prev.map((s) =>
          s.name === name ? { ...s, body, updatedAt: "just now", savedBy: "you" } : s,
        ),
      ),
    [],
  );
  const remove = useCallback(
    (name: string) => setSkills((prev) => prev.filter((s) => s.name !== name)),
    [],
  );
  const create = useCallback(
    () =>
      setSkills((prev) => [
        ...prev,
        {
          name: "new-skill",
          description: "Use this when…",
          body: "---\nname: new-skill\ndescription: Use this when…\n---\n\n## Steps\n1. \n",
          savedBy: "you",
          updatedAt: "just now",
        },
      ]),
    [],
  );

  const reset = useCallback(() => {
    setItems(startItems);
    setDemo(null);
    setSkills(seedSkills);
    setElapsed(0);
  }, []);

  return {
    items,
    demo,
    skills,
    elapsed: time(elapsed),
    start,
    act,
    pause,
    done,
    cancel,
    update,
    remove,
    create,
    reset,
  };
}

export type Stub = ReturnType<typeof useSkillsStub>;
