// The step-6 eval cases (spec #587, "The cheapest-first ladder"): does the main agent, under the
// Computer system prompt with its Helper tools, pick the cheapest rung? Each case has a structural
// check on the `start_helper` calls and the Messages of the Turn, and a judge check on the task it
// handed over or on its reply.

import type { HistoryExchange } from "./cases";

/** What a case's Turn must do. */
export type LadderExpect = {
  /**
   * The `start_helper` calls: `none` (no call), `general` or `computer_use` (exactly one call, of
   * that type), or `not-computer-use` (any calls, but none of that type).
   */
  helpers: "none" | "general" | "computer_use" | "not-computer-use";
  /** How many Messages the Turn sends: exactly one, or at least one. */
  sent: "one" | "some";
};

/** What the Turn is started by. */
export type LadderStart =
  | { kind: "user"; message: string }
  /** A Helper's report, the Trigger the Helper's end hands the Router (`helper` / `helper`). */
  | { kind: "helper"; type: "general" | "computer_use"; task: string; report: string };

export type LadderCase = {
  id: string;
  start: LadderStart;
  history?: HistoryExchange[];
  /** Whether the user has a Tavily key, so `web_search` works (a broken one is the case's point). */
  webSearch: boolean;
  expect: LadderExpect;
  /** What the judge reads: the task of the `start_helper` call, or the Messages the Turn sent. */
  judge: { on: "task" | "reply"; criterion: string };
  /** What the fake Model (the dry run) plays: these calls, then a reply that ends the Turn. */
  fake: { calls: { name: string; input: Record<string, unknown> }[]; reply: string };
};

const deskHistory: HistoryExchange[] = [
  {
    user: "I'm in Pune, and I only buy from sellers that deliver here.",
    bot: ["Got it: I'll only suggest sellers that deliver to Pune."],
  },
];

const deskTask =
  "Find the five best-reviewed standing desks under 30,000 rupees, compare price, warranty and " +
  "reviews, and save the comparison to a file.";

const deskReport =
  "Top picks (all deliver to Pune): 1. FlexiSpot E7 Lite, Rs 28,500, 5-year warranty, 4.6 stars. " +
  "2. Wakefit Rise, Rs 24,900, 3-year warranty, 4.4 stars. 3. Ergonify Pro, Rs 29,900, 2-year " +
  "warranty, 4.3 stars. Full comparison of five desks: bots/desks/comparison.md";

export const ladderCases: LadderCase[] = [
  {
    // What the Bot already knows: no Helper, and not even a search.
    id: "quick-question",
    start: { kind: "user", message: "What's the capital of Australia?" },
    webSearch: true,
    expect: { helpers: "none", sent: "some" },
    judge: {
      on: "reply",
      criterion: "The user asked for the capital of Australia. The reply must say it is Canberra.",
    },
    fake: { calls: [], reply: "The capital of Australia is Canberra." },
  },
  {
    // Bigger than a few tool calls, and it needs the web: a General Helper, with a task that carries
    // what only the earlier Conversation says (the user is in Pune).
    id: "research-task",
    start: { kind: "user", message: deskTask },
    history: deskHistory,
    webSearch: true,
    expect: { helpers: "general", sent: "some" },
    judge: {
      on: "task",
      criterion:
        "A Helper sees only this task, nothing of the conversation. The user, who earlier said they " +
        "are in Pune and only buy from sellers that deliver there, asked for the five best-reviewed " +
        "standing desks under 30,000 rupees, compared on price, warranty and reviews, saved to a " +
        "file. The task must stand alone: it must state the goal, the 30,000 rupee limit and that " +
        "sellers must deliver to Pune. It may word the rest differently, but must keep those three.",
    },
    fake: {
      calls: [
        {
          name: "start_helper",
          input: {
            type: "general",
            task:
              "Find the five best-reviewed standing desks under 30,000 rupees from sellers that " +
              "deliver to Pune. Compare price, warranty and reviews, save the comparison to a " +
              "file and report the top three.",
          },
        },
      ],
      reply: "I've started a Helper on the desk comparison and will report back.",
    },
  },
  {
    // Needs a website: a Computer-use Helper.
    id: "website-task",
    start: {
      kind: "user",
      message:
        "Go to bookmyshow.com and tell me which movies are showing in Pune this weekend, with their showtimes.",
    },
    webSearch: true,
    expect: { helpers: "computer_use", sent: "some" },
    judge: {
      on: "task",
      criterion:
        "A Helper sees only this task, nothing of the conversation. The user wants to know which " +
        "movies are showing in Pune this weekend, with their showtimes, from bookmyshow.com. The " +
        "task must stand alone: it must name the site, the city (Pune), the weekend and what to " +
        "report (the movies and their showtimes).",
    },
    fake: {
      calls: [
        {
          name: "start_helper",
          input: {
            type: "computer_use",
            task:
              "Open bookmyshow.com, pick Pune, and list the movies showing this weekend with their " +
              "showtimes. Report the movie names and times.",
          },
        },
      ],
      reply: "I've sent a Helper to bookmyshow.com and will report back.",
    },
  },
  {
    // The Bot's own Helper has finished: one Message with what matters, and no new Helper.
    id: "helper-report",
    start: { kind: "helper", type: "general", task: deskTask, report: deskReport },
    history: [
      ...deskHistory,
      {
        user: deskTask,
        bot: ["I've started a Helper on the desk comparison and will report back."],
      },
    ],
    webSearch: true,
    expect: { helpers: "none", sent: "one" },
    judge: {
      on: "reply",
      criterion:
        "A Helper finished the user's standing-desk comparison and reported three desks with " +
        "prices: FlexiSpot E7 Lite (Rs 28,500), Wakefit Rise (Rs 24,900) and Ergonify Pro " +
        "(Rs 29,900), with the full comparison in bots/desks/comparison.md. The reply is one " +
        "message to the user that gives the useful result: at least the best-reviewed desk and its " +
        "price, and where the full comparison is. It must not invent a desk or a price that is not " +
        "in the report.",
    },
    fake: {
      calls: [],
      reply:
        "Your comparison is done: the FlexiSpot E7 Lite (Rs 28,500) is best reviewed. The full " +
        "comparison is in bots/desks/comparison.md.",
    },
  },
  {
    // `web_search` is not set up, which the tool says. A Computer-use Helper would be the way around it.
    id: "broken-tool",
    start: { kind: "user", message: "What's the live score of the India match right now?" },
    webSearch: false,
    expect: { helpers: "not-computer-use", sent: "some" },
    judge: {
      on: "reply",
      criterion:
        "The user asked for a live score, and the assistant's web search is not set up, so it " +
        "cannot look it up. The reply must tell the user it cannot look the score up (search is " +
        "unavailable or not set up) and ask them what to do or what they would like (such as adding " +
        "a search key). It must not make up a score.",
    },
    fake: {
      calls: [{ name: "web_search", input: { query: "India match live score" } }],
      reply: "I can't look that up: web search isn't set up. Do you want to add a key in Settings?",
    },
  },
];
