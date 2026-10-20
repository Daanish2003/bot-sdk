// PROTOTYPE (#689): in-memory stub of a Bot's Auto-review verdicts, Approval requests and Secrets.
// Nothing is wired to the server. Lives on branch prototype/689-approval-ui only.
import { useCallback, useEffect, useState } from "react";

export const APPROVAL_MS = 15_000;

export type Approval = {
  state: "waiting" | "allowed" | "denied" | "expired";
  deadline: number;
};

/** One reviewed tool call: a `shell` command, or a Computer-use Helper's acting call. */
export type Review = {
  kind: "review";
  id: string;
  /** Who made the call: the Bot in a Turn, or one of its Helpers. */
  by: { kind: "bot" } | { kind: "helper"; helper: string; task: string };
  /** What woke the Turn, as the reviewer saw it. */
  trigger: "user" | "routine" | "webhook" | "helper";
  /** The call in plain words, then the raw tool and arguments. */
  summary: string;
  tool: string;
  args: string;
  verdict: "pass" | "block" | "error";
  reason: string;
  approval?: Approval;
  at: string;
};

export type Item =
  | { kind: "user"; text: string; at: string }
  | { kind: "bot"; text: string; at: string }
  | { kind: "trigger"; text: string; at: string }
  | { kind: "helper"; helper: string; task: string; at: string }
  | Review
  | { kind: "secret-request"; id: string; name: string; why: string; saved: boolean; at: string };

export type Secret = { name: string; savedAt: string };

const seed = (): Item[] => [
  { kind: "user", text: "Clone acme/site and run its tests, tell me what fails", at: "09:12" },
  {
    kind: "review",
    id: "r1",
    by: { kind: "bot" },
    trigger: "user",
    summary: "Clone acme/site from GitHub",
    tool: "shell",
    args: "git clone https://github.com/acme/site",
    verdict: "pass",
    reason: "The user asked to clone this repository.",
    at: "09:12",
  },
  {
    kind: "secret-request",
    id: "s1",
    name: "GITHUB_TOKEN",
    why: "acme/site is private, so I need a GitHub token to clone it.",
    saved: true,
    at: "09:12",
  },
  {
    kind: "review",
    id: "r2",
    by: { kind: "bot" },
    trigger: "user",
    summary: "Run the test suite",
    tool: "shell",
    args: "cd site && pnpm install && pnpm test",
    verdict: "pass",
    reason: "Running the project's tests is what the user asked for.",
    at: "09:13",
  },
  {
    kind: "bot",
    text: "2 tests fail, both in checkout.test.ts: the tax rate is off by one cent.",
    at: "09:14",
  },
  { kind: "trigger", text: "Webhook · Deploy finished (Routine)", at: "11:40" },
  {
    kind: "review",
    id: "r3",
    by: { kind: "bot" },
    trigger: "webhook",
    summary: "Post a message to the #general Slack channel",
    tool: "shell",
    args: 'curl -X POST https://hooks.slack.com/services/T0/B0/x -d \'{"text":"Deployed!"}\'',
    verdict: "block",
    reason:
      "This messages people in #general. You didn't ask for that; the request came from a webhook.",
    approval: { state: "expired", deadline: 0 },
    at: "11:40",
  },
  {
    kind: "bot",
    text: "Deploy finished. I didn't post to #general, since you hadn't asked me to.",
    at: "11:41",
  },
  { kind: "user", text: "Order the HDMI cable from my Amazon cart", at: "14:02" },
  {
    kind: "helper",
    helper: "Browser helper",
    task: "Order the HDMI cable in the Amazon cart",
    at: "14:02",
  },
  { kind: "bot", text: "On it. A browser helper is placing the order.", at: "14:02" },
];

let next = 10;

/** The stub's whole state, and the actions the variants and the switcher's buttons call. */
export function useSafetyStub() {
  const [items, setItems] = useState<Item[]>(seed);
  const [secrets, setSecrets] = useState<Secret[]>([
    { name: "GITHUB_TOKEN", savedAt: "Oct 21, 09:12" },
    { name: "NPM_TOKEN", savedAt: "Oct 18, 16:30" },
  ]);
  const [turnLive, setTurnLive] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Ticks the countdowns, and closes any request whose 15 seconds ran out: silence counts as no.
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setItems((all) =>
        all.map((item) =>
          item.kind === "review" &&
          item.approval?.state === "waiting" &&
          item.approval.deadline <= t
            ? { ...item, approval: { ...item.approval, state: "expired" } }
            : item,
        ),
      );
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const decide = useCallback((id: string, allow: boolean) => {
    setItems((all) =>
      all.map((item) =>
        item.kind === "review" && item.id === id && item.approval?.state === "waiting"
          ? { ...item, approval: { ...item.approval, state: allow ? "allowed" : "denied" } }
          : item,
      ),
    );
  }, []);

  const block = useCallback((from: "bot" | "helper" | "error") => {
    const id = `r${next++}`;
    const at = new Date().toTimeString().slice(0, 5);
    const approval: Approval = { state: "waiting", deadline: Date.now() + APPROVAL_MS };
    const review: Review =
      from === "helper"
        ? {
            kind: "review",
            id,
            by: {
              kind: "helper",
              helper: "Browser helper",
              task: "Order the HDMI cable in the Amazon cart",
            },
            trigger: "helper",
            summary: "Click “Place your order” on amazon.com ($12.99)",
            tool: "click",
            args: 'ref=e231 "Place your order"',
            verdict: "block",
            reason:
              "This pays $12.99. You asked for the order, but a payment always needs your OK.",
            approval,
            at,
          }
        : from === "error"
          ? {
              kind: "review",
              id,
              by: { kind: "bot" },
              trigger: "user",
              summary: "Delete the build folder",
              tool: "shell",
              args: "rm -rf site/dist",
              verdict: "error",
              reason: "Auto-review couldn't check this.",
              approval,
              at,
            }
          : {
              kind: "review",
              id,
              by: { kind: "bot" },
              trigger: "user",
              summary: "Push the fix straight to main on acme/site",
              tool: "shell",
              args: "cd site && git push origin main",
              verdict: "block",
              reason: "You asked me to fix the tests, not to push to main.",
              approval,
              at,
            };
    setTurnLive(from !== "helper");
    setItems((all) => [...all, review]);
  }, []);

  const pass = useCallback(() => {
    const at = new Date().toTimeString().slice(0, 5);
    setItems((all) => [
      ...all,
      {
        kind: "review",
        id: `r${next++}`,
        by: { kind: "bot" },
        trigger: "user",
        summary: "Run checkout.test.ts again",
        tool: "shell",
        args: "cd site && pnpm vitest checkout.test.ts",
        verdict: "pass",
        reason: "Re-running the failing tests is part of the user's request.",
        at,
      },
    ]);
  }, []);

  const askSecret = useCallback(() => {
    setItems((all) => [
      ...all,
      {
        kind: "secret-request",
        id: `s${next++}`,
        name: "STRIPE_API_KEY",
        why: "To check last week's refunds I need a Stripe restricted key (read-only is enough).",
        saved: false,
        at: new Date().toTimeString().slice(0, 5),
      },
    ]);
  }, []);

  const saveSecret = useCallback((id: string, name: string) => {
    setItems((all) =>
      all.map((item) =>
        item.kind === "secret-request" && item.id === id ? { ...item, saved: true } : item,
      ),
    );
    setSecrets((all) => [...all.filter((s) => s.name !== name), { name, savedAt: "just now" }]);
  }, []);

  const deleteSecret = useCallback((name: string) => {
    setSecrets((all) => all.filter((s) => s.name !== name));
  }, []);

  return {
    items,
    secrets,
    turnLive,
    now,
    decide,
    block,
    pass,
    askSecret,
    saveSecret,
    deleteSecret,
    reset: () => {
      setItems(seed());
      setTurnLive(false);
    },
  };
}

export type Stub = ReturnType<typeof useSafetyStub>;

export const reviews = (items: Item[]) => items.filter((i): i is Review => i.kind === "review");
export const waiting = (items: Item[]) =>
  reviews(items).filter((r) => r.approval?.state === "waiting");
export const secondsLeft = (approval: Approval, now: number) =>
  Math.max(0, Math.ceil((approval.deadline - now) / 1000));

/** The closed state of a request, in the words the UI uses. */
export function closedText(review: Review) {
  switch (review.approval?.state) {
    case "allowed":
      return `Allowed by you: ${review.summary}`;
    case "denied":
      return `Denied by you: ${review.summary}`;
    case "expired":
      return `Blocked, no answer in 15 s: ${review.summary}`;
    default:
      return review.summary;
  }
}
