// The pure parts of the Memory eval: which cases run, how a case's history is trimmed, and how the
// answers are tallied. Nothing here touches the database or a Model.

/** One turn of a history session, as the LongMemEval dataset writes it. */
export type Turn = { role: "user" | "assistant"; content: string };

/** One LongMemEval question, as the cleaned S file holds it (only the fields the eval reads). */
export type LongMemEvalItem = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
};

/** A question category: a dataset `question_type`, or abstention (an id ending in `_abs`). */
export const categories = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
  "abstention",
] as const;

export type Category = (typeof categories)[number];

/** How many cases each category gets (spec #263, "The eval"). */
export const quota: Record<Category, number> = {
  "single-session-user": 6,
  "single-session-assistant": 4,
  "single-session-preference": 4,
  "multi-session": 8,
  "temporal-reasoning": 8,
  "knowledge-update": 6,
  abstention: 4,
};

/** The committed case ids: the first n per category in sorted order (docs/research/longmemeval-eval.md). */
export const caseIds: Record<Category, readonly string[]> = {
  "single-session-user": ["001be529", "0862e8bf", "118b2229", "15745da0", "19b5f2b3", "1e043500"],
  "single-session-assistant": ["0e5e2d1a", "1568498a", "16c90bf4", "18dcd5a5"],
  "single-session-preference": ["06878be2", "06f04340", "07b6f563", "09d032c9"],
  "multi-session": [
    "00ca467f",
    "0100672e",
    "078150f1",
    "099778bb",
    "09ba9854",
    "0a995998",
    "0ea62687",
    "10d9b85a",
  ],
  "temporal-reasoning": [
    "08f4fc43",
    "0bb5a684",
    "0bc8ad92",
    "0bc8ad93",
    "0db4c65d",
    "2a1811e2",
    "2c63a862",
    "2ebe6c90",
  ],
  "knowledge-update": ["01493427", "031748ae", "06db6396", "07741c44", "07741c45", "08e075c7"],
  abstention: ["031748ae_abs", "0862e8bf_abs", "09ba9854_abs", "0ddfec37_abs"],
};

/** Filler sessions kept beside a case's evidence sessions. */
export const fillerCount = 8;

/** A history session, dated, with its turns in order. */
export type Session = { id: string; date: Date; turns: Turn[] };

/** A case selected from the dataset, with its category. */
export type EvalCase = { item: LongMemEvalItem; category: Category };

/** The category a question belongs to: abstention when its id ends in `_abs`, else its type. */
export function categoryOf(item: Pick<LongMemEvalItem, "question_id" | "question_type">): Category {
  if (item.question_id.endsWith("_abs")) return "abstention";
  const known = categories.find((category) => category === item.question_type);
  if (!known) throw new Error(`Unknown question_type "${item.question_type}"`);
  return known;
}

/** The committed ids, in category order. */
export function allCaseIds(): string[] {
  return categories.flatMap((category) => [...caseIds[category]]);
}

/**
 * The cases to run, in the committed order. Throws when an id is missing from the dataset, or when
 * the committed ids don't match the quota.
 */
export function selectCases(items: LongMemEvalItem[]): EvalCase[] {
  const byId = new Map(items.map((item) => [item.question_id, item]));
  const cases = categories.flatMap((category) =>
    caseIds[category].map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error(`Case ${id} is not in the dataset`);
      const actual = categoryOf(item);
      if (actual !== category) {
        throw new Error(`Case ${id} is ${actual}, but it is committed as ${category}`);
      }
      return { item, category };
    }),
  );
  for (const category of categories) {
    const count = caseIds[category].length;
    if (count !== quota[category]) {
      throw new Error(`${category} has ${count} cases, but the quota is ${quota[category]}`);
    }
  }
  return cases;
}

/**
 * Parses a dataset date such as `2023/05/20 (Sat) 02:21` as UTC. The eval only compares and orders
 * dates, so the zone is never shown to anyone.
 */
export function parseDate(value: string): Date {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([^)]*\) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Unrecognised dataset date "${value}"`);
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, hour, minute));
}

/**
 * A case's history: its evidence sessions plus its first `fillers` filler sessions, in timestamp
 * order (docs/research/longmemeval-eval.md). Ties keep the dataset's order.
 */
export function historyOf(item: LongMemEvalItem, fillers = fillerCount): Session[] {
  const evidence = new Set(item.answer_session_ids);
  const sessions = item.haystack_session_ids.map((id, index) => ({
    id,
    date: parseDate(item.haystack_dates[index]!),
    turns: item.haystack_sessions[index]!,
    index,
  }));
  const kept = [
    ...sessions.filter((session) => evidence.has(session.id)),
    ...sessions.filter((session) => !evidence.has(session.id)).slice(0, fillers),
  ];
  return kept
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.index - b.index)
    .map(({ id, date, turns }) => ({ id, date, turns }));
}

/** One scored case: its category and whether the judge said yes. */
export type Scored = { category: Category; correct: boolean };

export type Accuracy = { correct: number; total: number; accuracy: number | null };

/** Correct answers, the total, and the accuracy (null when there are no cases). */
function accuracyOf(rows: Scored[]): Accuracy {
  const correct = rows.filter((row) => row.correct).length;
  return {
    correct,
    total: rows.length,
    accuracy: rows.length === 0 ? null : correct / rows.length,
  };
}

/** Accuracy per category, and overall. Categories with no cases still appear, with a null accuracy. */
export function tally(rows: Scored[]): {
  perCategory: Record<Category, Accuracy>;
  overall: Accuracy;
} {
  const perCategory = Object.fromEntries(
    categories.map((category) => [
      category,
      accuracyOf(rows.filter((row) => row.category === category)),
    ]),
  ) as Record<Category, Accuracy>;
  return { perCategory, overall: accuracyOf(rows) };
}
