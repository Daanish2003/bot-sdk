// The week-one Turn eval's cases (spec #463, "Evals for the week-one Turn"): clear-cut ones only.
// A borderline message like "thanks!" is left out on purpose, since no answer to it is wrong.

/** One earlier exchange: the user's Message and the Messages the Bot sent back (none when quiet). */
export type HistoryExchange = { user: string; bot: string[] };

export type TurnCase = {
  id: string;
  /** `reply`: the Bot should send at least one Message. `quiet`: it should send none. */
  expected: "reply" | "quiet";
  /** A reply case that asks for several Messages, so the Bot should send two or more. */
  multi?: boolean;
  history: HistoryExchange[];
  /** The new user Message the Turn answers. */
  message: string;
};

const answered: HistoryExchange[] = [
  {
    user: "What's a good way to learn a new language?",
    bot: ["Practise a little every day, and talk to people as early as you can."],
  },
];

const quiet = (id: string, message: string, history = answered): TurnCase => ({
  id,
  expected: "quiet",
  history,
  message,
});

export const turnCases: TurnCase[] = [
  {
    id: "reply-question",
    expected: "reply",
    history: [],
    message: "What's the capital of Australia?",
  },
  { id: "reply-greeting", expected: "reply", history: [], message: "Hi!" },
  {
    id: "reply-task",
    expected: "reply",
    history: [],
    message: "Write me a two-line poem about autumn.",
  },
  {
    id: "reply-howto",
    expected: "reply",
    history: [],
    message: "How do I undo my last git commit but keep the changes?",
  },
  {
    id: "reply-translate",
    expected: "reply",
    history: [],
    message: "Translate 'good evening' into French and into Spanish.",
  },
  {
    id: "reply-name",
    expected: "reply",
    history: [],
    message: "Please suggest a name for my new cat.",
  },
  {
    id: "reply-followup",
    expected: "reply",
    history: answered,
    message: "Which of those would you start with if you only had ten minutes a day?",
  },
  {
    id: "reply-timezone",
    expected: "reply",
    history: [{ user: "Hello!", bot: ["Hi there. What can I do for you?"] }],
    message: "What time zone is New York in?",
  },
  {
    id: "reply-multi-tips",
    expected: "reply",
    multi: true,
    history: [],
    message: "Give me three tips for a job interview, each as its own separate message.",
  },
  {
    id: "reply-multi-two",
    expected: "reply",
    multi: true,
    history: [],
    message:
      "Send me a short good morning message, and then, as a second message, one productivity tip for today.",
  },
  quiet("quiet-thumbs-up", "👍"),
  quiet("quiet-ok", "ok"),
  quiet("quiet-got-it", "got it, thanks"),
  quiet("quiet-brb", "brb"),
  quiet("quiet-nvm", "nvm, figured it out"),
  quiet("quiet-k", "k"),
  quiet("quiet-will-do", "will do"),
  quiet("quiet-ttyl", "ttyl"),
  quiet("quiet-noted", "noted 👍"),
  quiet("quiet-ok-hand", "👌", [
    {
      user: "Can you remind me to drink water?",
      bot: ["Sure. Drink a glass of water now, and try one with every meal."],
    },
  ]),
];
