import { describe, expect, it } from "vitest";

import {
  type LongMemEvalItem,
  caseIds,
  categories,
  categoryOf,
  historyOf,
  parseDate,
  quota,
  selectCases,
  tally,
} from "../../../eval/memory/cases";
import { judgePrompt, verdictOf } from "../../../eval/memory/judge";

/** A dataset item with one filler per question id, typed as the id's category says. */
function itemFor(id: string, questionType: string, overrides: Partial<LongMemEvalItem> = {}) {
  return {
    question_id: id,
    question_type: questionType,
    question: `Question ${id}?`,
    answer: "An answer",
    question_date: "2023/06/01 (Thu) 09:00",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: [],
    ...overrides,
  } satisfies LongMemEvalItem;
}

/** The dataset for every committed id, typed by its category. */
function datasetForCommittedIds(): LongMemEvalItem[] {
  return categories.flatMap((category) =>
    caseIds[category].map((id) =>
      itemFor(id, category === "abstention" ? "single-session-user" : category),
    ),
  );
}

describe("the committed cases", () => {
  it("has 40 unique ids, with the quota of each category", () => {
    const all = categories.flatMap((category) => [...caseIds[category]]);
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
    for (const category of categories) {
      expect(caseIds[category]).toHaveLength(quota[category]);
    }
  });

  it("selects the committed cases from the dataset, in committed order", () => {
    const cases = selectCases(datasetForCommittedIds());
    expect(cases.map((c) => c.item.question_id)).toEqual(
      categories.flatMap((category) => [...caseIds[category]]),
    );
    expect(cases.every((c) => categoryOf(c.item) === c.category)).toBe(true);
  });

  it("refuses a committed id that the dataset does not hold", () => {
    const items = datasetForCommittedIds().filter((item) => item.question_id !== "001be529");
    expect(() => selectCases(items)).toThrow("Case 001be529 is not in the dataset");
  });

  it("refuses a committed id whose question_type is another category", () => {
    const items = datasetForCommittedIds().map((item) =>
      item.question_id === "001be529" ? { ...item, question_type: "multi-session" } : item,
    );
    expect(() => selectCases(items)).toThrow("is multi-session, but it is committed as");
  });

  it("classifies an id ending in _abs as abstention, whatever its type", () => {
    expect(categoryOf(itemFor("031748ae_abs", "knowledge-update"))).toBe("abstention");
    expect(categoryOf(itemFor("01493427", "knowledge-update"))).toBe("knowledge-update");
  });
});

describe("parseDate", () => {
  it("reads a dataset date as UTC", () => {
    expect(parseDate("2023/05/20 (Sat) 02:21").toISOString()).toBe("2023-05-20T02:21:00.000Z");
  });

  it("refuses a date in another shape", () => {
    expect(() => parseDate("20 May 2023")).toThrow("Unrecognised dataset date");
  });
});

describe("historyOf", () => {
  /** Sessions dated on successive days, with the given ids as evidence. */
  function itemWithSessions(count: number, evidence: string[], dayOf: (i: number) => number) {
    const ids = Array.from({ length: count }, (_, i) => `s${i}`);
    return itemFor("q1", "multi-session", {
      haystack_session_ids: ids,
      haystack_dates: ids.map((_, i) => `2023/05/${String(dayOf(i)).padStart(2, "0")} (Mon) 10:00`),
      haystack_sessions: ids.map((id) => [{ role: "user", content: `turn of ${id}` }]),
      answer_session_ids: evidence,
    });
  }

  it("keeps the evidence sessions and the first 8 fillers, in timestamp order", () => {
    // 12 sessions on days 1..12. Evidence: s9 and s11. Fillers: s0..s8 and s10, of which the first 8
    // are s0..s7, so s8 and s10 are dropped.
    const item = itemWithSessions(12, ["s11", "s9"], (i) => i + 1);
    const ids = historyOf(item).map((session) => session.id);
    expect(ids).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s9", "s11"]);
  });

  it("keeps every session when the haystack has 8 fillers or fewer", () => {
    const item = itemWithSessions(5, ["s4"], (i) => 5 - i);
    expect(historyOf(item).map((session) => session.id)).toEqual(["s4", "s3", "s2", "s1", "s0"]);
  });

  it("dates each session and keeps its turns", () => {
    const item = itemWithSessions(1, ["s0"], () => 3);
    const [session] = historyOf(item);
    expect(session?.date.toISOString()).toBe("2023-05-03T10:00:00.000Z");
    expect(session?.turns).toEqual([{ role: "user", content: "turn of s0" }]);
  });
});

describe("tally", () => {
  it("counts correct answers per category and overall", () => {
    const { perCategory, overall } = tally([
      { category: "multi-session", correct: true },
      { category: "multi-session", correct: false },
      { category: "abstention", correct: true },
    ]);
    expect(perCategory["multi-session"]).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(perCategory.abstention).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(overall).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
  });

  it("gives a null accuracy for a category with no cases", () => {
    const { perCategory } = tally([]);
    expect(perCategory["temporal-reasoning"]).toEqual({ correct: 0, total: 0, accuracy: null });
  });
});

describe("judgePrompt", () => {
  const input = { question: "Q?", expected: "E", response: "R" };

  it("uses LongMemEval's standard prompt for the plain question types", () => {
    const prompt = judgePrompt({ ...input, category: "multi-session" });
    expect(prompt).toContain("Please answer yes if the response contains the correct answer.");
    expect(prompt).toContain("Question: Q?\n\nCorrect Answer: E\n\nModel Response: R");
    expect(prompt).not.toContain("off-by-one");
  });

  it("adds the off-by-one allowance for temporal reasoning", () => {
    expect(judgePrompt({ ...input, category: "temporal-reasoning" })).toContain("off-by-one");
  });

  it("uses the updated-answer prompt for knowledge updates", () => {
    expect(judgePrompt({ ...input, category: "knowledge-update" })).toContain(
      "updated answer is the required answer",
    );
  });

  it("judges a preference against the rubric", () => {
    const prompt = judgePrompt({ ...input, category: "single-session-preference" });
    expect(prompt).toContain("a rubric for desired personalized response");
    expect(prompt).toContain("Rubric: E");
  });

  it("judges an abstention on whether the question is identified as unanswerable", () => {
    const prompt = judgePrompt({ ...input, category: "abstention" });
    expect(prompt).toContain("Explanation: E");
    expect(prompt).toContain("Does the model correctly identify the question as unanswerable?");
  });
});

describe("verdictOf", () => {
  it("counts a reply containing yes in any case as yes, as LongMemEval does", () => {
    expect(verdictOf("Yes.")).toBe(true);
    expect(verdictOf("yes")).toBe(true);
    expect(verdictOf("No")).toBe(false);
  });
});
