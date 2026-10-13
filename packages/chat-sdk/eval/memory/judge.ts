// The LongMemEval judge, ported to TypeScript.
//
// The prompts are copied from LongMemEval's `src/evaluation/evaluate_qa.py`
// (https://github.com/xiaowu0162/LongMemEval), which is released under the MIT License:
//
// MIT License
//
// Copyright (c) 2024 Di Wu
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { Category } from "./cases";

const standard =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no";

const temporal =
  "In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.";

const knowledgeUpdate =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.";

const preference =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.";

const abstention =
  "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.";

/** What the judge reads for one case: the question, its expected answer, and the model's reply. */
export type JudgeInput = {
  category: Category;
  question: string;
  /** The correct answer; a rubric for a preference question; an explanation for an abstention. */
  expected: string;
  /** The Memory-backed reply under test. */
  response: string;
};

/**
 * The judge prompt for one case, chosen by its category (LongMemEval's `get_anscheck_prompt`).
 * Abstention is judged by its own prompt; the rest by their question type.
 */
export function judgePrompt({ category, question, expected, response }: JudgeInput): string {
  const body = (
    label: "Correct Answer" | "Rubric" | "Explanation",
    closing: string,
    lead: string,
  ) =>
    `${lead}\n\nQuestion: ${question}\n\n${label}: ${expected}\n\nModel Response: ${response}\n\n${closing}`;
  const yesNo = "Is the model response correct? Answer yes or no only.";

  switch (category) {
    case "temporal-reasoning":
      return body("Correct Answer", yesNo, `${standard}. ${temporal}`);
    case "knowledge-update":
      return body("Correct Answer", yesNo, knowledgeUpdate);
    case "single-session-preference":
      return body("Rubric", yesNo, preference);
    case "abstention":
      return body(
        "Explanation",
        "Does the model correctly identify the question as unanswerable? Answer yes or no only.",
        abstention,
      );
    default:
      return body("Correct Answer", yesNo, standard);
  }
}

/** LongMemEval's verdict: the reply counts as yes when it contains "yes", in any case. */
export function verdictOf(reply: string): boolean {
  return reply.toLowerCase().includes("yes");
}

/** Judges one case with `complete`, which sends a prompt to the judge Model at temperature 0. */
export async function judge(
  complete: (prompt: string) => Promise<string>,
  input: JudgeInput,
): Promise<{ correct: boolean; reply: string }> {
  const reply = await complete(judgePrompt(input));
  return { correct: verdictOf(reply), reply };
}
