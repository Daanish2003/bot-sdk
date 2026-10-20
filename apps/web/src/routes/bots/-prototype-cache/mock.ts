// PROTOTYPE (#663): stub data for the cache-hit UI. One Bot's day on Anthropic (1-hour TTL),
// with a cold first Turn, warm hits, a cache warming call, a bug miss (the memory snapshot
// was re-read mid-conversation), a Summary while away, and the expected miss after it.

export const sectionNames = [
  "tools",
  "rules",
  "computer",
  "memory",
  "routines",
  "first message",
  "history",
  "newest",
] as const;
export type SectionName = (typeof sectionNames)[number];

/** hit: read from cache. write: written to cache (new). miss: changed when it shouldn't have. fresh: never cached (the newest message). */
export type CellStatus = "hit" | "write" | "miss" | "fresh";

export type Section = {
  name: SectionName;
  tokens: number;
  hash: string;
  status: CellStatus;
  was?: string;
};

export type Step = {
  id: string;
  label: string;
  sections: Section[];
  read: number;
  write: number;
  uncached: number;
  output: number;
  cost: number;
  /** The first section that differs from the previous call, when that's a bug. */
  bug?: SectionName;
  /** Why a miss is expected, e.g. a new Prompt start after a Summary. */
  expected?: string;
};

export type ThreadItem =
  | { kind: "user"; at: string; text: string }
  | { kind: "trigger"; at: string; text: string }
  | { kind: "turn"; id: string; at: string; messages: string[]; steps: Step[] }
  | { kind: "warm"; id: string; at: string; step: Step }
  | {
      kind: "summary";
      id: string;
      at: string;
      type: "away" | "mid_turn";
      text: string;
      kept: string[];
      step: Step;
    };

// Sonnet-ish prices, $ per 1M tokens: input 3, cache read 0.1x, 1-hour cache write 2x, output 15.
const price = { input: 3, read: 0.3, write: 6, output: 15 };

const prefix: [SectionName, number][] = [
  ["tools", 3200],
  ["rules", 1400],
  ["computer", 600],
  ["memory", 2800],
  ["routines", 300],
  ["first message", 900],
];

const hashes: Record<string, string> = {};
function hashOf(name: string, version: number) {
  const key = `${name}:${version}`;
  hashes[key] ??= Math.abs([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8);
  return hashes[key];
}

let stepCount = 0;
/**
 * One model call. `history` is the tokens of history before this call; `cachedHistory` how much of it
 * the previous call already sent. `version` bumps a section's hash; `cold` writes everything.
 */
function step(opts: {
  label?: string;
  history: number;
  cachedHistory: number;
  newest: number;
  output: number;
  cold?: boolean;
  versions?: Partial<Record<SectionName, number>>;
  bugAt?: SectionName;
  expected?: string;
}): Step {
  const sections: Section[] = [];
  let missed = false;
  for (const [name, tokens] of prefix) {
    const v = opts.versions?.[name] ?? 0;
    const changed = opts.bugAt === name;
    if (changed) missed = true;
    sections.push({
      name,
      tokens,
      hash: hashOf(name, v),
      status: opts.cold ? "write" : changed ? "miss" : missed ? "write" : "hit",
      was: changed ? hashOf(name, v - 1) : undefined,
    });
  }
  sections.push({
    name: "history",
    tokens: opts.history,
    hash: hashOf(`history-${opts.history}`, 0),
    status: opts.cold || missed ? "write" : opts.cachedHistory >= opts.history ? "hit" : "write",
  });
  sections.push({
    name: "newest",
    tokens: opts.newest,
    hash: hashOf(`newest-${stepCount}`, 0),
    status: "fresh",
  });

  const prefixTokens = prefix.reduce((n, [, t]) => n + t, 0);
  let read = 0;
  let write = 0;
  if (opts.cold) write = prefixTokens + opts.history;
  else if (missed) {
    const idx = prefix.findIndex(([n]) => n === opts.bugAt);
    read = prefix.slice(0, idx).reduce((n, [, t]) => n + t, 0);
    write = prefixTokens - read + opts.history;
  } else {
    read = prefixTokens + Math.min(opts.cachedHistory, opts.history);
    write = Math.max(0, opts.history - opts.cachedHistory);
  }
  const uncached = opts.newest;
  const cost =
    (read * price.read +
      write * price.write +
      uncached * price.input +
      opts.output * price.output) /
    1_000_000;
  stepCount += 1;
  return {
    id: `s${stepCount}`,
    label: opts.label ?? `Step ${stepCount}`,
    sections,
    read,
    write,
    uncached,
    output: opts.output,
    cost,
    bug: opts.bugAt,
    expected: opts.expected,
  };
}

const summaryText =
  "Daanish is planning the week of 19 October. Gym moved from Tuesday to Thursday 07:00. Friday has a 10:00 design review and a dentist call to book. The Bot checked the calendar twice and set a Check-in for 14:00 to confirm the review room.";

export const thread: ThreadItem[] = [
  {
    kind: "user",
    at: "09:02",
    text: "Plan my week, I've got gym, the design review and the dentist.",
  },
  {
    kind: "turn",
    id: "t1",
    at: "09:02",
    messages: ["Here's a draft for Mon–Fri. Gym is Tuesday 07:00, the review is Friday 10:00."],
    steps: [
      step({ label: "Step 1", history: 0, cachedHistory: 0, newest: 40, output: 120, cold: true }),
      step({ label: "Step 2", history: 1800, cachedHistory: 0, newest: 0, output: 90 }),
      step({ label: "Step 3", history: 4200, cachedHistory: 1800, newest: 0, output: 180 }),
    ],
  },
  { kind: "user", at: "09:30", text: "Move gym to Thursday." },
  {
    kind: "turn",
    id: "t2",
    at: "09:30",
    messages: ["Done: gym is Thursday 07:00."],
    steps: [
      step({ label: "Step 1", history: 4600, cachedHistory: 4600, newest: 30, output: 60 }),
      step({ label: "Step 2", history: 5400, cachedHistory: 4630, newest: 0, output: 40 }),
    ],
  },
  {
    kind: "warm",
    id: "w1",
    at: "11:15",
    step: step({
      label: "Warm",
      history: 5600,
      cachedHistory: 0,
      newest: 0,
      output: 0,
      cold: true,
    }),
  },
  { kind: "user", at: "11:16", text: "What's on Friday?" },
  {
    kind: "turn",
    id: "t3",
    at: "11:16",
    messages: ["Friday: design review at 10:00. The dentist call isn't booked yet."],
    steps: [step({ label: "Step 1", history: 5600, cachedHistory: 5600, newest: 25, output: 70 })],
  },
  { kind: "trigger", at: "14:00", text: "Check-in: confirm the review room for Friday." },
  {
    kind: "turn",
    id: "t4",
    at: "14:00",
    messages: ["Room 4B is booked for the review on Friday."],
    steps: [
      step({
        label: "Step 1",
        history: 98_000,
        cachedHistory: 98_000,
        newest: 60,
        output: 150,
        versions: { memory: 1 },
        bugAt: "memory",
      }),
      step({
        label: "Step 2",
        history: 104_000,
        cachedHistory: 98_060,
        newest: 0,
        output: 300,
        versions: { memory: 1 },
      }),
    ],
  },
  {
    kind: "summary",
    id: "sum1",
    at: "14:10",
    type: "away",
    text: summaryText,
    kept: [
      "09:30 · Done: gym is Thursday 07:00.",
      "11:16 · Friday: design review at 10:00. The dentist call isn't booked yet.",
      "14:00 · Room 4B is booked for the review on Friday.",
    ],
    step: step({
      label: "Summary",
      history: 106_000,
      cachedHistory: 106_000,
      newest: 200,
      output: 900,
      versions: { memory: 1 },
    }),
  },
  { kind: "user", at: "15:05", text: "Book the dentist for Friday afternoon." },
  {
    kind: "turn",
    id: "t5",
    at: "15:05",
    messages: ["Booked: dentist Friday 15:30. I added it to your calendar."],
    steps: [
      step({
        label: "Step 1",
        history: 0,
        cachedHistory: 0,
        newest: 35,
        output: 110,
        cold: true,
        versions: { memory: 2, "first message": 1, routines: 1 },
        expected: "New Prompt start after the Summary",
      }),
      step({
        label: "Step 2",
        history: 1400,
        cachedHistory: 0,
        newest: 0,
        output: 80,
        versions: { memory: 2, "first message": 1, routines: 1 },
      }),
    ],
  },
];

export function totals(steps: Step[]) {
  const t = steps.reduce(
    (a, s) => ({
      read: a.read + s.read,
      write: a.write + s.write,
      uncached: a.uncached + s.uncached,
      output: a.output + s.output,
      cost: a.cost + s.cost,
    }),
    { read: 0, write: 0, uncached: 0, output: 0, cost: 0 },
  );
  const input = t.read + t.write + t.uncached;
  const uncachedCost = (input * price.input + t.output * price.output) / 1_000_000;
  return { ...t, input, hitRate: input ? t.read / input : 0, saved: uncachedCost - t.cost };
}

export function stepsOf(item: ThreadItem): Step[] {
  if (item.kind === "turn") return item.steps;
  if (item.kind === "warm" || item.kind === "summary") return [item.step];
  return [];
}

export const allSteps = thread.flatMap((item) => stepsOf(item).map((s) => ({ item, step: s })));

export const fmt = {
  tokens: (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`),
  pct: (n: number) => `${Math.round(n * 100)}%`,
  usd: (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 3)}`,
};

export const statusClass: Record<CellStatus, string> = {
  hit: "bg-emerald-500",
  write: "bg-amber-400",
  miss: "bg-red-500",
  fresh: "bg-zinc-300 dark:bg-zinc-600",
};

export const statusLabel: Record<CellStatus, string> = {
  hit: "read from cache",
  write: "written to cache",
  miss: "changed: cache miss (bug)",
  fresh: "not cached (newest)",
};
