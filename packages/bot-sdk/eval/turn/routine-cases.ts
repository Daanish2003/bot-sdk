// The step-4 eval cases (spec #543, "Evals: Routines and Check-ins with a real Model"): a user
// Message that should or should not make the Bot save a Routine or set a Check-in, and Turns woken
// by a Routine's run or a fired Check-in. Each has a structural check on the Turn's tool calls and
// Messages, and most have a judge check.

import type { HistoryExchange } from "./cases";

/** What a case's Turn must do, read from its transcript. A key left out is not checked. */
export type RoutineExpect = {
  /** Whether the Turn calls `create_routine`. */
  createRoutine?: boolean;
  /** Whether the Turn calls `set_check_in`. */
  setCheckIn?: boolean;
  /** How many Messages the Turn sends: none, exactly one, or at least one. */
  sent?: "none" | "one" | "some";
};

/** What the Turn is started by. */
export type RoutineStart =
  | { kind: "user"; message: string }
  /** A Routine's run: the Trigger the fire hands the Router, with the Routine's prompt. */
  | { kind: "routine"; name: string; prompt: string }
  /** A fired Check-in: the Trigger with the note the Bot left itself. */
  | { kind: "check_in"; note: string };

export type RoutineCase = {
  id: string;
  start: RoutineStart;
  history?: HistoryExchange[];
  expect: RoutineExpect;
  /** What the judge reads: a tool call's input, or the Messages the Turn sent. Not judged when absent. */
  judge?: { on: "create_routine" | "set_check_in" | "reply"; criterion: string };
};

const releaseHistory: HistoryExchange[] = [
  {
    user: "Every morning, tell me if vite or react shipped a new version.",
    bot: ["Done, I set up a Routine for that."],
  },
];

export const routineCases: RoutineCase[] = [
  {
    id: "routine-recurring",
    start: {
      kind: "user",
      message: "Every weekday at 8am, give me a short summary of the top tech news.",
    },
    expect: { createRoutine: true },
    judge: {
      on: "create_routine",
      criterion:
        "The user asked for a short summary of the top tech news every weekday at 8am. The " +
        "Routine's name must be a short slug about it, its prompt must tell the Bot to give that " +
        "summary, and its schedule must be the five weekdays (mon to fri) at 08:00.",
    },
  },
  {
    // A question with no schedule: no Routine, and an answer reaches the user.
    id: "routine-one-off",
    start: { kind: "user", message: "What's the capital of Australia?" },
    expect: { createRoutine: false, sent: "some" },
  },
  {
    id: "routine-check-back",
    start: { kind: "user", message: "I sent the contract to Priya. Check back with me Thursday." },
    expect: { setCheckIn: true, createRoutine: false },
    judge: {
      on: "set_check_in",
      criterion:
        "The user said to check back on Thursday about a contract they sent to Priya. The " +
        "Check-in's `at` must be a Thursday in the future (its weekday, whether it is in the future, the time now and the user's time zone are given) and its note must mention the " +
        "contract or Priya.",
    },
  },
  {
    // The prompt carries both days' data: the Bot has no tool to look anything up.
    id: "routine-run-nothing-new",
    start: {
      kind: "routine",
      name: "release-watch",
      prompt:
        "Tell me when vite or react ships a new version. Latest versions yesterday: vite 7.1.0, " +
        "react 19.2.0. Latest versions today: vite 7.1.0, react 19.2.0.",
    },
    history: releaseHistory,
    expect: { sent: "none" },
  },
  {
    id: "routine-run-something-new",
    start: {
      kind: "routine",
      name: "release-watch",
      prompt:
        "Tell me when vite or react ships a new version. Latest versions yesterday: vite 7.1.0, " +
        "react 19.2.0. Latest versions today: vite 7.2.0, react 19.2.0.",
    },
    history: releaseHistory,
    expect: { sent: "one" },
    judge: {
      on: "reply",
      criterion:
        "A morning check found that vite shipped version 7.2.0 (it was 7.1.0) and react did not " +
        "change. The message must tell the user about the new vite version, and must not say " +
        "react has a new version.",
    },
  },
  {
    id: "check-in-fired",
    start: {
      kind: "check_in",
      note: "Ask whether Priya replied about the contract, and offer to draft a reminder if not.",
    },
    history: [
      {
        user: "I sent the contract to Priya. Check back with me Thursday.",
        bot: ["Will do, I'll check in with you Thursday."],
      },
    ],
    expect: { sent: "some" },
    judge: {
      on: "reply",
      criterion:
        "The Bot had set itself a Check-in whose note said to ask whether Priya replied about the " +
        "contract, and to offer a reminder if not. The message must ask the user whether Priya " +
        "replied about the contract, or follow up on it by offering a reminder.",
    },
  },
];
