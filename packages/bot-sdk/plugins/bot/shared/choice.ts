import { z } from "zod";

/** The most options one choice offers. */
export const maxChoiceOptions = 8;

/** The longest option, and the longest free-text "Other" answer, in characters. */
export const maxChoiceOptionLength = 100;
export const maxChoiceOtherLength = 1_000;

/** What the user answered: the option they picked, or the free text they wrote under "Other". */
export const choiceAnswerSchema = z.object({
  text: z.string(),
  other: z.boolean(),
});

export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;

/**
 * A question with options to pick from (spec #761), the Rich control of kind `choice`: the
 * Message's text is the question. `other` adds a free-text answer. `answer` is the answered state;
 * the first answer fills it, and later ones are refused.
 */
export const choiceControlSchema = z.object({
  kind: z.literal("choice"),
  options: z.array(z.string().min(1).max(maxChoiceOptionLength)).min(2).max(maxChoiceOptions),
  other: z.boolean(),
  answer: choiceAnswerSchema.optional(),
});

export type ChoiceControl = z.infer<typeof choiceControlSchema>;

/** What the Bot sees when the user answers: `Answered "<question>": <answer>`. */
export const answeredChoiceText = (question: string, answer: string) =>
  `Answered "${question}": ${answer}`;

/** What the user answers: one of the options, or the free text of "Other". */
export type ChoiceInput = { option: string } | { other: string };
