// The Proactive eval's cases (spec #1024, ticket #1032). Each case's user has one Connection, "Mail",
// over the SDK's fake MCP server, holding scripted inbox items. A case is one or more Turns of one
// Bot, each woken by a Routine (the Watch, read-only, or the Morning brief) or by a user Message:
//
//   watch-quiet          nothing is new: the Watch sends nothing
//   watch-no-repeat      the one item is already in the Notes: it sends nothing
//   watch-urgent         an urgent item: it is sent, marked `urgent`
//   watch-note-brief     a non-urgent item: a Note, no Message; the next brief then includes it
//   watch-write-draft    the item needs a reply (a write): a draft with a choice, no error loop
//   first-offers         the first Bot, after its first Connection, offers both Routines
//
// The Watch's and the brief's prompts are the SDK's own defaults (`proactiveRoutinesPrompt`), so the
// eval judges what a Host gets. Each Turn also has two scripts for the dry run (`--fake`): `good`,
// what a sound Bot does, which must score a pass, and `broken`, what a Bot under a deliberately
// broken prompt does, which must score a fail (`--fake --broken`).

import { proactiveRoutinesPrompt } from "@botsdk/bot/bot/context";
import type { FakeMcpTool } from "@ai-chat/test-support/fake-mcp-server";
import type { Expect } from "./score";

/** One scripted tool call (a Connector or Routine tool goes through `run_tool`). */
export type Step = { name: string; input: Record<string, unknown> };

/** What a script may need to know about its run. */
export type ScriptContext = { notesPath: string; today: string };

export type Start =
  /** A fire of the user's read-only Watch. */
  | { kind: "watch" }
  /** A fire of the user's Morning brief. */
  | { kind: "brief" }
  /** A Message from the user. */
  | { kind: "user"; message: string };

export type ProactiveTurn = {
  start: Start;
  /** What `list_inbox` returns in this Turn. */
  inbox: string;
  expect: Expect;
  good: (context: ScriptContext) => Step[];
  broken: (context: ScriptContext) => Step[];
};

export type ProactiveCase = {
  id: string;
  gating: boolean;
  summary: string;
  /** Written to the Bot's `notes.md` before the first Turn, with `{today}` filled in. */
  notes?: string;
  turns: ProactiveTurn[];
};

/** The eval's Connection: its server key and name, and the tool that needs no Auto-review. */
export const mailServer = { key: "mail", name: "Mail", approvalFree: ["list_inbox"] };

/** The Mail server's tools: a read the server marks read-only, and a write with no hint. */
export function mailTools(inbox: string): FakeMcpTool[] {
  return [
    {
      name: "list_inbox",
      description:
        "List the recent emails in the user's inbox that arrived since the last check, with " +
        "sender, subject and a short preview.",
      annotations: { readOnlyHint: true },
      result: inbox,
    },
    {
      name: "send_email",
      description: "Send an email from the user's account to a recipient.",
      result: "Sent.",
    },
  ];
}

/** The Watch's and the Morning brief's default prompts, read from the SDK's guidance. */
function defaultPrompts() {
  const brief = /Its prompt: "(Review[^"]*)"/.exec(proactiveRoutinesPrompt)?.[1];
  const watch = /Its prompt: "(Check[^"]*)"/.exec(proactiveRoutinesPrompt)?.[1];
  if (!brief || !watch) throw new Error("proactiveRoutinesPrompt no longer names both prompts");
  return { brief: brief.replace(/\\'/g, "'"), watch: watch.replace(/\\'/g, "'") };
}

export const defaultRoutinePrompts = defaultPrompts();

/** The two default Routines' schedules, as the guidance gives them. */
export const weekdays = ["mon", "tue", "wed", "thu", "fri"];
export const watchTimes = ["11:00", "14:00", "17:00", "20:00"];

const send = (input: Record<string, unknown>): Step => ({
  name: "send_to_user",
  input: { endTurn: true, ...input },
});
const viaTool = (name: string, args: Record<string, unknown> = {}): Step => ({
  name: "run_tool",
  input: { name, args },
});
const listInbox = () => viaTool("mail_list_inbox");

const acmeItem =
  "From Acme Billing, subject: Invoice #4411 is due Friday. Preview: Please pay invoice #4411 " +
  "(USD 1,200) by Friday 31 October.";

export const proactiveCases: ProactiveCase[] = [
  {
    id: "watch-quiet",
    gating: true,
    summary: "Nothing is new: the Watch stays quiet.",
    turns: [
      {
        start: { kind: "watch" },
        inbox: "No new emails since the last check.",
        expect: { kind: "quiet" },
        good: () => [listInbox()],
        broken: () => [listInbox(), send({ text: "I checked your inbox and nothing is new." })],
      },
    ],
  },
  {
    id: "watch-no-repeat",
    gating: true,
    summary: "The one item is already in the Notes: the Watch doesn't say it again.",
    notes:
      "- {today} Acme Billing invoice #4411 (USD 1,200) is due Friday; for the morning brief.\n",
    turns: [
      {
        start: { kind: "watch" },
        inbox: acmeItem,
        expect: { kind: "quiet" },
        good: ({ notesPath }) => [{ name: "read", input: { path: notesPath } }, listInbox()],
        broken: () => [
          listInbox(),
          send({ text: "Acme Billing's invoice #4411 is due on Friday." }),
        ],
      },
    ],
  },
  {
    id: "watch-urgent",
    gating: true,
    summary: "An urgent item: the Watch sends it, marked urgent.",
    turns: [
      {
        start: { kind: "watch" },
        inbox:
          "From Stripe Alerts, subject: URGENT payments are failing. Preview: Since 13:40 every " +
          "checkout returns a 500 and customers cannot pay. Action is needed now.",
        expect: { kind: "urgent", item: /payment|checkout|stripe|customers/i },
        good: () => [
          listInbox(),
          send({
            text: "Payments are failing: since 13:40 every checkout returns a 500 and customers can't pay.",
            urgent: true,
          }),
        ],
        broken: () => [
          listInbox(),
          send({
            text: "Payments are failing: since 13:40 every checkout returns a 500 and customers can't pay.",
          }),
        ],
      },
    ],
  },
  {
    id: "watch-note-brief",
    gating: true,
    summary: "A non-urgent item: a Note and no Message, and the next brief includes it.",
    turns: [
      {
        start: { kind: "watch" },
        inbox:
          "From Lena Ortiz, subject: Q3 planning deck. Preview: Sharing the draft deck for the " +
          "Q3 planning meeting. No rush, any time before the 12th is fine.",
        expect: { kind: "note", item: /lena|q3|planning/i },
        good: ({ notesPath, today }) => [
          listInbox(),
          {
            name: "write",
            input: {
              path: notesPath,
              content: `- ${today} Lena Ortiz shared the Q3 planning deck; no rush, before the 12th.\n`,
            },
          },
        ],
        broken: () => [
          listInbox(),
          send({ text: "Lena Ortiz shared the Q3 planning deck. No rush." }),
        ],
      },
      {
        start: { kind: "brief" },
        inbox: "No new emails.",
        expect: { kind: "brief-includes", item: /lena|q3|planning/i },
        good: () => [
          listInbox(),
          send({
            text: "One thing from the Watch: Lena Ortiz shared the Q3 planning deck (no rush).",
          }),
        ],
        broken: () => [listInbox()],
      },
    ],
  },
  {
    id: "watch-write-draft",
    gating: true,
    summary: "The item needs a reply (a write): a draft with a choice, not an error loop.",
    turns: [
      {
        start: { kind: "watch" },
        inbox:
          "From Priya Nair, subject: Can you confirm Thursday 3pm? Preview: Can you confirm " +
          "Thursday at 3pm for the design review? I need a yes or no by end of day.",
        expect: { kind: "draft", item: /priya|thursday|design review/i },
        good: () => [
          listInbox(),
          send({
            text:
              "Priya needs a yes or no by end of day for the design review on Thursday at 3pm. " +
              'Draft reply: "Thursday at 3pm works for me." Send it?',
            choice: { options: ["Send it", "Don't send"] },
          }),
        ],
        broken: () => [
          listInbox(),
          viaTool("mail_send_email", { to: "priya@example.com", body: "Thursday 3pm works." }),
          viaTool("mail_send_email", { to: "priya@example.com", body: "Thursday 3pm works." }),
          viaTool("mail_send_email", { to: "priya@example.com", body: "Thursday 3pm works." }),
          send({ text: "I could not send the reply." }),
        ],
      },
    ],
  },
  {
    id: "first-offers",
    gating: true,
    summary:
      "After its user's first Connection, the first Bot offers the Morning brief and the Watch.",
    turns: [
      {
        start: { kind: "user", message: "Hi! I just connected my email." },
        inbox: "No new emails.",
        expect: { kind: "offers" },
        good: () => [
          viaTool("create_routine", {
            name: "morning-brief",
            prompt: defaultRoutinePrompts.brief,
            schedule: { days: weekdays, times: ["08:00"] },
          }),
          viaTool("create_routine", {
            name: "check-my-apps",
            prompt: defaultRoutinePrompts.watch,
            schedule: { days: weekdays, times: watchTimes },
            readOnly: true,
          }),
          send({
            text: "Welcome! I set up a Morning brief and a Watch for your apps. Approve them to start.",
          }),
        ],
        broken: () => [send({ text: "Welcome! Let me know what you need." })],
      },
    ],
  },
];
