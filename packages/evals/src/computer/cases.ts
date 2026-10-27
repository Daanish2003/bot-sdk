// The tool-use eval's cases (spec #519, "Evals"): clear-cut ones only. A `use` case asks for
// something only the Computer can do reliably (compute a number, keep a file, read one back, edit
// one); a `none` case is plain chat, where touching the Computer is wrong.

/** One earlier exchange: the user's Message and the Messages the Bot sent back. */
export type HistoryExchange = { user: string; bot: string[] };

/** What a case's check can look at once the Turn has ended. */
export type Outcome = {
  /** The text of each Message the Bot sent. */
  sent: string[];
  /** A file in the Bot's directory (relative path), or null when there is none. */
  file: (path: string) => Promise<string | null>;
};

/** A step of the fake Model's script for a case: a tool call a good Bot would make. */
export type FakeCall = { name: string; input: Record<string, unknown> };

export type ComputerCase = {
  id: string;
  /** `use`: the Bot should touch the Computer. `none`: it should not. */
  expected: "use" | "none";
  history: HistoryExchange[];
  /** Files put in the Bot's directory before the Turn, as earlier Turns would have left them. */
  seed?: { path: string; content: string }[];
  /** The new user Message the Turn answers. */
  message: string;
  /** What is wrong with the Turn's result, in words; empty when it is right. */
  check?: (outcome: Outcome) => Promise<string[]>;
  /** What the fake Model (the dry run) plays: these calls, then a reply. */
  fake: { calls: FakeCall[]; reply: string };
};

const product = (48271n * 9137n).toString();

const launchCode = "7391-ALPHA";

const ensure = (problems: string[], condition: boolean, problem: string) => {
  if (!condition) problems.push(problem);
};

export const computerCases: ComputerCase[] = [
  {
    id: "compute-product",
    expected: "use",
    history: [],
    message: "What is 48271 times 9137? Work it out on your computer and tell me the exact number.",
    check: async ({ sent }) => {
      const problems: string[] = [];
      const said = sent.join(" ").replace(/[,\s_]/g, "");
      ensure(problems, said.includes(product), `the reply does not give ${product}`);
      return problems;
    },
    fake: {
      calls: [{ name: "shell", input: { command: "echo $((48271 * 9137))" } }],
      reply: `48271 times 9137 is ${product}.`,
    },
  },
  {
    id: "save-note",
    expected: "use",
    history: [],
    message: "Save a note in a file called groceries.txt that says: milk, eggs, bread.",
    check: async ({ file }) => {
      const content = await file("groceries.txt");
      if (content === null) return ["groceries.txt was not saved in the Bot's directory"];
      const problems: string[] = [];
      for (const item of ["milk", "eggs", "bread"]) {
        ensure(problems, content.includes(item), `groceries.txt lacks "${item}"`);
      }
      return problems;
    },
    fake: {
      calls: [{ name: "write", input: { path: "groceries.txt", content: "milk, eggs, bread\n" } }],
      reply: "Saved it in groceries.txt.",
    },
  },
  {
    id: "read-earlier-file",
    expected: "use",
    history: [
      {
        user: `Please save the launch code ${launchCode} in launch-code.txt.`,
        bot: ["Saved it in launch-code.txt."],
      },
    ],
    seed: [{ path: "launch-code.txt", content: `Launch code: ${launchCode}\n` }],
    message: "Read the launch code back to me from the file you saved it in.",
    check: async ({ sent }) => {
      const problems: string[] = [];
      ensure(
        problems,
        sent.join(" ").includes(launchCode),
        `the reply does not give ${launchCode}`,
      );
      return problems;
    },
    fake: {
      calls: [{ name: "read", input: { path: "launch-code.txt" } }],
      reply: `The launch code is ${launchCode}.`,
    },
  },
  {
    id: "edit-file",
    expected: "use",
    history: [],
    seed: [{ path: "config.txt", content: "mode=draft\nowner=sam\nretries=3\n" }],
    message: "In config.txt, change mode from draft to final. Leave everything else as it is.",
    check: async ({ file }) => {
      const content = await file("config.txt");
      if (content === null) return ["config.txt is gone"];
      const problems: string[] = [];
      ensure(problems, content.includes("mode=final"), "config.txt does not say mode=final");
      ensure(problems, !content.includes("draft"), "config.txt still says draft");
      ensure(problems, content.includes("owner=sam"), "config.txt lost owner=sam");
      ensure(problems, content.includes("retries=3"), "config.txt lost retries=3");
      return problems;
    },
    fake: {
      calls: [
        {
          name: "edit",
          input: { path: "config.txt", oldText: "mode=draft", newText: "mode=final" },
        },
      ],
      reply: "Changed mode to final.",
    },
  },
  {
    id: "chat-greeting",
    expected: "none",
    history: [],
    message: "Hi! How are you today?",
    fake: { calls: [], reply: "Hi! I'm doing well. How can I help?" },
  },
  {
    id: "chat-capital",
    expected: "none",
    history: [],
    message: "What's the capital of Australia?",
    fake: { calls: [], reply: "Canberra." },
  },
  {
    id: "chat-poem",
    expected: "none",
    history: [],
    message: "Write me a two-line poem about autumn.",
    fake: { calls: [], reply: "Leaves drift down in gold,\nthe year grows soft and old." },
  },
  {
    id: "chat-explain",
    expected: "none",
    history: [],
    message: "Explain in one sentence what a hash map is.",
    fake: {
      calls: [],
      reply: "A hash map stores key-value pairs and finds a value from its key in constant time.",
    },
  },
];
