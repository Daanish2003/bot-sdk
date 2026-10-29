// The step-8 eval cases (spec #665, #678, "Evals: cache stability, Summaries, tool search"): what a
// real Model must do, and what the dry run's fake Model plays in its place. Scored by
// context-score.ts, run by context-run.ts.

import type { HistoryExchange } from "./cases";

// ---- Cache stability --------------------------------------------------------------------------

/** One step of the scripted Conversation the cache eval plays, in order. */
export type CacheStep =
  | { kind: "user"; message: string }
  /** The Bot's profile gets a line, as a Turn's memory pass would write it. */
  | { kind: "memory"; line: string }
  /** A Routine is saved and approved, then fires: the Trigger a fire hands the Router. */
  | { kind: "routine"; name: string; prompt: string }
  /** The Bot's usage rows are made two hours old, then `warmBot` runs: the cache is due a warm. */
  | { kind: "warm" };

export const cacheSteps: CacheStep[] = [
  {
    kind: "user",
    message: "Hi! I'm Maya. I'm planning a trip to Lisbon in March, so please remember that.",
  },
  { kind: "memory", line: "Lives in Pune" },
  { kind: "user", message: "What's a good way to spend a rainy afternoon?" },
  {
    kind: "routine",
    name: "trip-countdown",
    prompt: "Tell me in one short line how many weeks are left until my Lisbon trip.",
  },
  { kind: "user", message: "Thanks. Any tips for packing light?" },
  { kind: "memory", line: "Is vegetarian" },
  { kind: "warm" },
  { kind: "user", message: "Remind me which city I'm travelling to?" },
];

/** What the fake Model replies to each user Message and Routine run of the cache script, in order. */
export const cacheFakeReplies = [
  "Nice to meet you Maya, Lisbon in March it is.",
  "A book and a hot drink always works.",
  "Four weeks to go.",
  "Roll your clothes and bring one pair of shoes.",
  "Lisbon.",
];

// ---- Summary ----------------------------------------------------------------------------------

/** A fact planted early in the Conversation, and what the Bot is asked for it at the end. */
export type PlantedFact = { said: string; reply: string; answer: string };

export const plantedFacts: PlantedFact[] = [
  {
    said: "My dog is called Biscuit, he's a three-year-old beagle.",
    reply: "Biscuit the beagle, lovely name.",
    answer: "Biscuit",
  },
  {
    said: "My flight to Lisbon is TP1347 on 14 March.",
    reply: "Noted: TP1347 to Lisbon on 14 March.",
    answer: "TP1347",
  },
  {
    said: "The trip budget is 2,400 euros, no more.",
    reply: "Got it, 2,400 euros at most.",
    answer: "2,400",
  },
];

export const summaryQuestion =
  "Quick check before I go: what is my dog called, what is my flight number, and what is my trip budget?";

export const summaryCriterion =
  "The user asked for their dog's name, their flight number and their trip budget. The reply must " +
  "give all three correctly: the dog is Biscuit, the flight is TP1347, and the budget is 2,400 euros.";

/** How many filler exchanges follow the planted facts. */
export const fillerExchanges = 45;

/** Characters in each filler exchange's pasted notes, so the whole Conversation passes the away Summary's input size. */
export const fillerCharacters = 12_000;

const words = (
  "the of and to in is that for it with as was on be at by this had not are but from or have an " +
  "they which one you were her all she there would their we him been has when who will more no " +
  "if out so said what up its about into than them can only other new some could time these two " +
  "may then do first any my now such like our over man me even most made after also did many " +
  "before must through back years where much your way well down should because each just those " +
  "people mr how too little state good very make world still own see men work long get here " +
  "between both life being under never day same another know while last might us great old year " +
  "off come since against go came right used take three budget invoice schedule review draft " +
  "customer supplier meeting agenda decision action owner deadline quarter forecast contract"
).split(" ");

/**
 * About `characters` of plain text from the word list, the same every call for the same `seed`.
 * Words come from a small generator, not a repeat, so a Model's tokenizer finds no easy shortcut.
 */
export function fillerText(seed: number, characters: number): string {
  let state = (seed + 1) * 2654435761;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state;
  };
  const out: string[] = [];
  let length = 0;
  while (length < characters) {
    const word = words[next() % words.length]!;
    out.push(word);
    length += word.length + 1;
  }
  return out.join(" ");
}

/** The history the Summary eval starts from: the planted facts, then filler notes to file. */
export function summaryHistory(
  exchanges = fillerExchanges,
  characters = fillerCharacters,
): HistoryExchange[] {
  return [
    ...plantedFacts.map((fact) => ({ user: fact.said, bot: [fact.reply] })),
    ...Array.from({ length: exchanges }, (_, i) => ({
      user: `Please file these meeting notes, no summary needed.\n\n${fillerText(i, characters)}`,
      bot: [`Filed notes batch ${i + 1} of ${exchanges}.`],
    })),
  ];
}

/** What the fake Model's Summary says, in place of the real one. */
export const fakeSummaryProse =
  "The user has a dog called Biscuit, a flight TP1347 to Lisbon on 14 March and a budget of 2,400 euros.";

// ---- Tool search ------------------------------------------------------------------------------

/** What a tool search case needs the Bot to load and call. */
export type ToolSearchCase = {
  id: string;
  message: string;
  /** The deferred tool the Bot must load with `describe_tool` and call with `run_tool`. */
  tool: "set_check_in" | "create_routine" | "check_helper";
  /** History written before the Turn. */
  history?: HistoryExchange[];
  /** A running Helper written before the Turn, so there is one to check on. */
  helper?: { task: string };
  /** The arguments the fake Model plays for the `run_tool` call; the Helper's id is filled in. */
  fakeArgs: Record<string, unknown>;
};

export const helperTask =
  "Compare five standing desks under 30,000 rupees that deliver to Pune, and save the table to desks.md.";

export const toolSearchCases: ToolSearchCase[] = [
  {
    id: "tool-reminder",
    message: "Remind me on Friday morning to renew my passport.",
    tool: "set_check_in",
    fakeArgs: {
      at: "2099-01-01T09:00:00+05:30",
      note: "Remind the user to renew their passport.",
    },
  },
  {
    id: "tool-routine",
    message: "Every Monday at 9am, send me a short list of my priorities for the week.",
    tool: "create_routine",
    fakeArgs: {
      name: "weekly-priorities",
      prompt: "Send the user a short list of their priorities for the week.",
      schedule: { days: ["mon"], times: ["09:00"] },
    },
  },
  {
    id: "tool-helper",
    message: "How is that desk research going?",
    tool: "check_helper",
    history: [
      {
        user: "Can you find me a good standing desk? Under 30,000 rupees, delivered to Pune.",
        bot: ["On it, I've started a Helper to research that."],
      },
    ],
    helper: { task: helperTask },
    fakeArgs: {},
  },
];
